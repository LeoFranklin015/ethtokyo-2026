"use client";

import { useCallback, useEffect, useState } from "react";
import {
  useAccount,
  useCapabilities,
  usePublicClient,
  useSendCalls,
  useSendTransaction,
  useWaitForCallsStatus,
  useWriteContract,
} from "wagmi";
import { encodeFunctionData, keccak256, toHex, type Address, type Hex } from "viem";
import { ethRegistryWriteAbi, orgFactoryAbi, registryAbi } from "@/lib/ens/abis";
import { ENS } from "@/lib/ens/config";
import { recordEnsName } from "@/lib/ens/recordName";

/**
 * Turning a name you own into an organization.
 *
 * Owning `acme.eth` gets you a name. An organization is four contracts underneath it — a
 * registry to hold branches, a resolver to publish records, an OrgRegistrar for the Member
 * layer, and a BranchFactory to open branches — and until this existed they were deploy scripts
 * an operator ran by hand. So the console had exactly one organization, and picking a different
 * name changed a label on screen while branches still landed under the original.
 *
 * Three calls, and ideally one confirmation.
 *
 *   1. grant the factory permission to point the name (the owner's own call)
 *   2. `createOrganization` — deploys the four contracts, points the name, hands root over
 *   3. revoke that permission again
 *
 * Where the wallet supports EIP-5792 `wallet_sendCalls`, those go as one atomic batch: one
 * prompt, one confirmation, and no way to end up with an organization that exists but is not
 * pointed at because somebody closed the tab between two transactions. That half-finished state
 * is what made this step feel flaky.
 *
 * Where it does not, the same three run sequentially and the result is identical — slower, and
 * interruptible, which is why the UI can always resume from whatever actually landed.
 */

export type OrgAddresses = {
  registry: Address;
  resolver: Address;
  orgRegistrar: Address;
  branchFactory: Address;
  node: Hex;
};

export type SetupState =
  | { step: "unknown" }
  | { step: "none" }
  | { step: "deployed"; org: OrgAddresses; pointed: boolean };

const ZERO = "0x0000000000000000000000000000000000000000";

/** `ROLE_SET_SUBREGISTRY | ROLE_SET_RESOLVER` — exactly what pointing a name needs, nothing more. */
const POINTING_ROLES = (1n << 20n) | (1n << 24n);

export function useOrgSetup(label: string | null) {
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const { chainId } = useAccount();
  const { sendCallsAsync } = useSendCalls();
  const { sendTransactionAsync } = useSendTransaction();
  const { data: capabilities } = useCapabilities();
  const [state, setState] = useState<SetupState>({ step: "unknown" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [batchId, setBatchId] = useState<string | undefined>();

  // Does this wallet execute a batch atomically? EIP-7702 accounts and smart accounts do; a
  // plain EOA in an older wallet does not, and gets the sequential path instead.
  const atomic = chainId ? capabilities?.[chainId]?.atomic?.status : undefined;
  const batchable = atomic === "supported" || atomic === "ready";

  // When batched, the calls land together — so the UI learns the outcome from the batch, not
  // from three separate receipts.
  const { data: batchStatus } = useWaitForCallsStatus({ id: batchId });

  /** What, if anything, already exists for this name. */
  const refresh = useCallback(async () => {
    if (!label || !publicClient) return;
    setError(null);
    try {
      const org = (await publicClient.readContract({
        address: ENS.orgFactory as Address,
        abi: orgFactoryAbi,
        functionName: "organizationFor",
        args: [label],
      })) as OrgAddresses;

      if (org.registry === ZERO) {
        setState({ step: "none" });
        return;
      }

      // Deployed, but is the name actually pointed at it? Without that, nothing resolves and
      // the organization is a set of contracts nobody can find.
      const pointedAt = (await publicClient.readContract({
        address: ENS.ethRegistry as Address,
        abi: registryAbi,
        functionName: "getSubregistry",
        args: [label],
      })) as Address;

      const pointed = pointedAt.toLowerCase() === org.registry.toLowerCase();
      setState({ step: "deployed", org, pointed });
      // Recorded once the name resolves to its own registry, which is the point at which the
      // organization is real to everything else here. The server re-reads the factory before
      // believing it, so a repeat costs nothing.
      if (pointed) void recordEnsName({ name: `${label}.eth`, kind: "organization" });
    } catch (e) {
      setError(readable(e));
    }
  }, [label, publicClient]);

  useEffect(() => {
    let live = true;
    void Promise.resolve().then(() => {
      if (live) void refresh();
    });
    return () => {
      live = false;
    };
  }, [refresh]);

  /**
   * Deploy the organization and point the name at it.
   *
   * One batched call where the wallet allows it, three transactions where it does not.
   */
  const create = useCallback(async () => {
    if (!label || !publicClient) return;
    setBusy(true);
    setError(null);
    try {
      const tokenId = BigInt(keccak256(toHex(label)));
      const resource = (await publicClient.readContract({
        address: ENS.ethRegistry as Address,
        abi: registryAbi,
        functionName: "getResource",
        args: [tokenId],
      })) as bigint;

      const grant = {
        to: ENS.ethRegistry as Address,
        data: encodeFunctionData({
          abi: ethRegistryWriteAbi,
          functionName: "grantRoles",
          args: [resource, POINTING_ROLES, ENS.orgFactory as Address],
        }),
      };
      const create_ = {
        to: ENS.orgFactory as Address,
        data: encodeFunctionData({
          abi: orgFactoryAbi,
          functionName: "createOrganization",
          args: [label, dnsEncode(`${label}.eth`)],
        }),
      };
      const revoke = {
        to: ENS.ethRegistry as Address,
        data: encodeFunctionData({
          abi: ethRegistryWriteAbi,
          functionName: "revokeRoles",
          args: [resource, POINTING_ROLES, ENS.orgFactory as Address],
        }),
      };

      if (batchable) {
        const result = await sendCallsAsync({ calls: [grant, create_, revoke] });
        setBatchId(typeof result === "string" ? result : result.id);
      } else {
        // The same three, one at a time. Each is awaited before the next, so a failure stops
        // the sequence rather than leaving the grant outstanding.
        for (const call of [grant, create_, revoke]) {
          const hash = await sendTransactionAsync({ to: call.to, data: call.data });
          await publicClient.waitForTransactionReceipt({ hash });
        }
        await refresh();
      }
    } catch (e) {
      setError(readable(e));
    } finally {
      setBusy(false);
    }
  }, [batchable, label, publicClient, refresh, sendCallsAsync, sendTransactionAsync]);

  useEffect(() => {
    if (batchStatus?.status !== "success") return;
    // Deferred so the re-read lands in its own render pass rather than cascading out of this one.
    let live = true;
    void Promise.resolve().then(() => {
      if (live) void refresh();
    });
    return () => {
      live = false;
    };
  }, [batchStatus?.status, refresh]);

  /** The fallback when the factory was not delegated: point the name yourself, afterwards. */
  const point = useCallback(async () => {
    if (!label || !publicClient || state.step !== "deployed") return;
    setBusy(true);
    setError(null);
    try {
      const tokenId = BigInt(keccak256(toHex(label)));
      const sub = await writeContractAsync({
        address: ENS.ethRegistry as Address,
        abi: ethRegistryWriteAbi,
        functionName: "setSubregistry",
        args: [tokenId, state.org.registry],
      });
      await publicClient.waitForTransactionReceipt({ hash: sub });

      const res = await writeContractAsync({
        address: ENS.ethRegistry as Address,
        abi: ethRegistryWriteAbi,
        functionName: "setResolver",
        args: [tokenId, state.org.resolver],
      });
      await publicClient.waitForTransactionReceipt({ hash: res });
      await refresh();
    } catch (e) {
      setError(readable(e));
    } finally {
      setBusy(false);
    }
  }, [label, publicClient, refresh, state, writeContractAsync]);

  return { state, busy, error, batchable, create, point, refresh };
}

/** `acme.eth` → `\x04acme\x03eth\x00`, which is what the factory hashes to derive the node. */
export function dnsEncode(name: string): Hex {
  const bytes: number[] = [];
  for (const part of name.split(".")) {
    const encoded = new TextEncoder().encode(part);
    bytes.push(encoded.length, ...encoded);
  }
  bytes.push(0);
  return `0x${bytes.map((b) => b.toString(16).padStart(2, "0")).join("")}` as Hex;
}

function readable(e: unknown): string {
  if (!(e instanceof Error)) return "something went wrong";
  const m = e.message;
  if (/User rejected|denied transaction/i.test(m)) return "You rejected that request.";
  if (/NotTheNameOwner/.test(m)) return "This wallet does not own that name.";
  if (/AlreadySetUp/.test(m)) return "That name already has an organization.";
  if (/NameNotRegistered/.test(m)) return "That name is not registered yet.";
  if (/insufficient funds/i.test(m)) return "This wallet has no Sepolia ETH for gas.";
  return m.split("\n")[0]!.slice(0, 160);
}
