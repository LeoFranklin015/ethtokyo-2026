"use client";

import { useCallback, useState } from "react";
import {
  useAccount,
  useCapabilities,
  useConfig,
  usePublicClient,
  useWriteContract,
} from "wagmi";
import { sendCalls, waitForCallsStatus } from "@wagmi/core";
import { decodeEventLog, encodeFunctionData, type Address, type Hex } from "viem";
import { branchFactoryAbi, registrarWriteAbi } from "@/lib/ens/abis";
import { recordEnsName } from "@/lib/ens/recordName";

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

export type GroupDefinition = {
  name: string;
  canOnboard: boolean;
  openToOnboarders: boolean;
  editableKeys: string[];
  entitlements: Entitlement[];
};

/**
 * What happened to one group, named.
 *
 * `skipped` is not a failure: it is a group the sequential path never reached because an
 * earlier one stopped it. Keeping it distinct from `failed` is what lets the UI say which
 * groups exist on chain and which were never asked for, instead of lumping them together.
 */
export type GroupOutcome =
  | { name: string; status: "defined"; txHash: Hex }
  | { name: string; status: "failed"; error: string }
  | { name: string; status: "skipped" };

export type DefineGroupsResult = { mode: "batched" | "sequential"; outcomes: GroupOutcome[] };

export function useEnsWrites() {
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const config = useConfig();
  const { chainId } = useAccount();
  const { data: capabilities } = useCapabilities();
  const [state, setState] = useState<WriteState>(IDLE);

  // Whether this wallet executes several calls as one atomic batch — EIP-5792. Smart accounts
  // and EIP-7702 EOAs do; a plain EOA in an older wallet does not, and must be given the
  // sequential path rather than an error.
  const atomic = chainId ? capabilities?.[chainId]?.atomic?.status : undefined;
  const batchable = atomic === "supported" || atomic === "ready";

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
    (label: string, expiry: bigint, owner: Address, factory: Address, organization: string) =>
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
              // A branch is not listable from the chain alone, and the indexer will not have it
              // for a while — so record it now, while we hold the registrar the receipt named.
              void recordEnsName({
                name: `${args.label}.${organization.replace(/\.eth$/, "")}.eth`,
                kind: "branch",
                owner,
                registrar: args.registrar,
                txHash: hash,
              });
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
   * Define several groups on one branch.
   *
   * Each group is its own `defineRole`, so N groups are N calls however they are sent. Where the
   * wallet batches them, the operator confirms once and the chain either takes all of them or
   * none — which is the point: a half-defined branch is a branch whose onboarding form offers
   * groups that do not exist.
   *
   * Where it does not, they go one at a time and the first failure stops the run. The ones that
   * already landed are reported by name so a retry can send only what is missing; re-sending a
   * group that succeeded would work, but it would ask the operator to pay and confirm for
   * nothing and would hide which attempt actually did it.
   */
  const defineGroups = useCallback(
    async (registrar: Address, groups: GroupDefinition[]): Promise<DefineGroupsResult> => {
      const args = (g: GroupDefinition) =>
        [g.name, 0n, g.canOnboard, g.openToOnboarders, g.editableKeys, g.entitlements] as const;

      setState({ busy: true, error: null, txHash: null });

      if (batchable) {
        try {
          const sent = await sendCalls(config, {
            calls: groups.map((g) => ({
              to: registrar,
              data: encodeFunctionData({
                abi: registrarWriteAbi,
                functionName: "defineRole",
                args: args(g),
              }),
            })),
          });
          const id = typeof sent === "string" ? sent : sent.id;
          const result = await waitForCallsStatus(config, { id });
          if (result.status !== "success") {
            throw new Error("the wallet reported that the batch did not go through");
          }
          const txHash = result.receipts?.[0]?.transactionHash ?? ("0x" as Hex);
          setState({ busy: false, error: null, txHash });
          return {
            mode: "batched",
            outcomes: groups.map((g) => ({ name: g.name, status: "defined", txHash })),
          };
        } catch (e) {
          // Atomic, so a failure here means nothing was written — every group is still pending.
          const error = readableError(e);
          setState({ busy: false, error, txHash: null });
          return {
            mode: "batched",
            outcomes: groups.map((g) => ({ name: g.name, status: "failed", error })),
          };
        }
      }

      const outcomes: GroupOutcome[] = [];
      let failure: string | null = null;
      for (const [i, group] of groups.entries()) {
        try {
          const hash = await writeContractAsync({
            address: registrar,
            abi: registrarWriteAbi,
            functionName: "defineRole",
            args: args(group),
          });
          await publicClient!.waitForTransactionReceipt({ hash });
          outcomes.push({ name: group.name, status: "defined", txHash: hash });
        } catch (e) {
          failure = readableError(e);
          outcomes.push({ name: group.name, status: "failed", error: failure });
          for (const rest of groups.slice(i + 1)) {
            outcomes.push({ name: rest.name, status: "skipped" });
          }
          break;
        }
      }
      const landed = outcomes.filter((o) => o.status === "defined");
      setState({
        busy: false,
        error: failure,
        txHash: landed.length > 0 ? (landed[landed.length - 1] as { txHash: Hex }).txHash : null,
      });
      return { mode: "sequential", outcomes };
    },
    [batchable, config, publicClient, writeContractAsync],
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

  return {
    ...state,
    batchable,
    createBranch,
    defineGroup,
    defineGroups,
    onboard,
    revoke,
    reset: () => setState(IDLE),
  };
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
