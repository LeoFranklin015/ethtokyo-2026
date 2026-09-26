"use client";

import { useCallback, useState } from "react";
import { usePublicClient, useWriteContract } from "wagmi";
import { decodeEventLog, type Address, type Hex } from "viem";
import { branchFactoryAbi, registrarWriteAbi } from "@/lib/ens/abis";

/**
 * Every ENS write, signed by whoever is connected.
 *
 * There is no server wallet. There used to be one — a single `ORG_PRIVATE_KEY` that created
 * branches, defined groups, onboarded members and revoked them — and it was wrong in three
 * separate ways:
 *
 *   1. **It duplicated authorisation that already exists on chain.** The contracts enforce this
 *      themselves: `ROLE_CREATE_BRANCH` on the factory, `ROLE_ROLE_EDIT` and `ROLE_MINT` on a
 *      branch registrar. A server key holding all of them replaced that per-actor check with
 *      "did the request reach our server", which is a weaker question.
 *   2. **It made the console a custodian.** Compromising the web host meant compromising the
 *      organization, because the key that owned everything lived there.
 *   3. **It forced a gate in front of the product.** Because the key spent real money, every
 *      write had to sit behind a shared console token — so a stranger who wanted to try the
 *      thing was told "console authentication required" before they had done anything.
 *
 * With the owner signing, all three go away. The chain refuses a caller who lacks the role, the
 * console holds nothing worth stealing, and anyone can create an organization and run it.
 */

export type WriteState = { busy: boolean; error: string | null; txHash: Hex | null };

const IDLE: WriteState = { busy: false, error: null, txHash: null };

export type Entitlement = { key: string; value: string };

export function useEnsWrites() {
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const [state, setState] = useState<WriteState>(IDLE);

  const run = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T | null> => {
      setState({ busy: true, error: null, txHash: null });
      try {
        const result = await fn();
        setState((s) => ({ ...s, busy: false }));
        return result;
      } catch (e) {
        setState({ busy: false, error: readableError(e), txHash: null });
        return null;
      }
    },
    [],
  );

  /**
   * Open a branch. One transaction: registry, registrar, both parent pointers, the authority
   * grants and the discovery record.
   *
   * Reads the result out of the receipt rather than waiting for an indexer, so the next step of
   * the flow has the registrar address immediately.
   */
  const createBranch = useCallback(
    // The organization's own factory, always. There is no default: falling back to a
    // configured one is what made a branch land under somebody else's organization.
    (label: string, expiry: bigint, owner: Address, factory: Address) =>
      run(async () => {
        const hash = await writeContractAsync({
          address: factory,
          abi: branchFactoryAbi,
          functionName: "createBranch",
          args: [label, expiry, owner],
        });
        const receipt = await publicClient!.waitForTransactionReceipt({ hash });
        setState((s) => ({ ...s, txHash: hash }));

        for (const log of receipt.logs) {
          try {
            const decoded = decodeEventLog({
              abi: branchFactoryAbi,
              data: log.data,
              topics: log.topics,
            });
            if (decoded.eventName === "BranchCreated") {
              const args = decoded.args as unknown as {
                label: string;
                node: Hex;
                registry: Address;
                registrar: Address;
              };
              return { ...args, txHash: hash };
            }
          } catch {
            // Logs from the registries and the resolver are in this receipt too; skip them.
          }
        }
        throw new Error("the branch was created but the factory emitted no BranchCreated");
      }),
    [publicClient, run, writeContractAsync],
  );

  /** Define or redefine a group on a branch. Requires `ROLE_ROLE_EDIT` on that registrar. */
  const defineGroup = useCallback(
    (input: {
      registrar: Address;
      name: string;
      canOnboard: boolean;
      openToOnboarders: boolean;
      editableKeys: string[];
      entitlements: Entitlement[];
    }) =>
      run(async () => {
        const hash = await writeContractAsync({
          address: input.registrar,
          abi: registrarWriteAbi,
          functionName: "defineRole",
          args: [
            input.name,
            0n,
            input.canOnboard,
            input.openToOnboarders,
            input.editableKeys,
            input.entitlements,
          ],
        });
        await publicClient!.waitForTransactionReceipt({ hash });
        setState((s) => ({ ...s, txHash: hash }));
        return { txHash: hash };
      }),
    [publicClient, run, writeContractAsync],
  );

  /**
   * Onboard somebody. Requires `ROLE_MINT` on the role's resource — which a branch owner holds
   * at the root, and which a member of a `canOnboard` group gets derived for them. That derived
   * path is why an organization can run unlimited volunteers, and it works here unchanged: the
   * volunteer signs with their own wallet and the contract works out that they may.
   */
  const onboard = useCallback(
    (input: {
      registrar: Address;
      label: string;
      owner: Address;
      roleId: Hex;
      memberLabel: string;
    }) =>
      run(async () => {
        const hash = await writeContractAsync({
          address: input.registrar,
          abi: registrarWriteAbi,
          functionName: "onboard",
          args: [input.label, input.owner, input.roleId, input.memberLabel],
        });
        await publicClient!.waitForTransactionReceipt({ hash });
        setState((s) => ({ ...s, txHash: hash }));
        return { txHash: hash };
      }),
    [publicClient, run, writeContractAsync],
  );

  /** End a membership. Requires `ROLE_REVOKE` — deliberately not the record-editing role. */
  const revoke = useCallback(
    (registrar: Address, resource: bigint) =>
      run(async () => {
        const hash = await writeContractAsync({
          address: registrar,
          abi: registrarWriteAbi,
          functionName: "revoke",
          args: [resource],
        });
        await publicClient!.waitForTransactionReceipt({ hash });
        setState((s) => ({ ...s, txHash: hash }));
        return { txHash: hash };
      }),
    [publicClient, run, writeContractAsync],
  );

  return { ...state, createBranch, defineGroup, onboard, revoke, reset: () => setState(IDLE) };
}

/**
 * Wallet and chain errors are long, and the useful part is rarely the last line.
 *
 * A reverted custom error is the contract refusing on authority, which is the most likely thing
 * to happen now that the chain does the checking — so name it plainly rather than showing
 * somebody a stack of ABI decoding notes.
 */
function readableError(e: unknown): string {
  if (!(e instanceof Error)) return "something went wrong";
  const m = e.message;
  if (/User rejected|denied transaction/i.test(m)) return "You rejected that request.";
  if (/NotABranchCreator/.test(m)) return "This wallet may not open branches for this organization.";
  if (/NotARoleEditor/.test(m)) return "This wallet may not edit this branch's groups.";
  if (/CannotMintRole/.test(m)) return "This wallet may not onboard anyone into that group.";
  if (/NotARevoker/.test(m)) return "This wallet may not end memberships here.";
  if (/AlreadyOnboarded/.test(m)) return "That wallet already holds a membership at this branch.";
  if (/LabelUnavailable/.test(m)) return "That name is already taken here.";
  if (/insufficient funds/i.test(m)) return "This wallet has no Sepolia ETH for gas.";
  return m.split("\n")[0]!.slice(0, 160);
}
