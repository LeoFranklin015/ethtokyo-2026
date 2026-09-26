"use client";

import { useCallback, useEffect, useState } from "react";
import { usePublicClient, useWriteContract } from "wagmi";
import { keccak256, toHex, type Address, type Hex } from "viem";
import { ethRegistryWriteAbi, orgFactoryAbi, registryAbi } from "@/lib/ens/abis";
import { ENS } from "@/lib/ens/config";

/**
 * Turning a name you own into an organization.
 *
 * Owning `acme.eth` gets you a name. An organization is four contracts underneath it — a
 * registry to hold branches, a resolver to publish records, an OrgRegistrar for the Member
 * layer, and a BranchFactory to open branches — and until this existed they were deploy scripts
 * an operator ran by hand. So the console had exactly one organization, and picking a different
 * name changed a label on screen while branches still landed under the original.
 *
 * Two transactions, both from the owner's wallet, and both necessary:
 *
 *   1. `createOrganization` deploys the four contracts and hands root of all of them over.
 *   2. `setSubregistry` points the `.eth` name at the new registry. The factory cannot do this —
 *      only the name's owner may — which is exactly why it is a separate step rather than a
 *      hidden one.
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

export function useOrgSetup(label: string | null) {
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const [state, setState] = useState<SetupState>({ step: "unknown" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

      setState({
        step: "deployed",
        org,
        pointed: pointedAt.toLowerCase() === org.registry.toLowerCase(),
      });
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

  /** Step 1: deploy the organization's own contracts. */
  const create = useCallback(async () => {
    if (!label || !publicClient) return;
    setBusy(true);
    setError(null);
    try {
      const hash = await writeContractAsync({
        address: ENS.orgFactory as Address,
        abi: orgFactoryAbi,
        functionName: "createOrganization",
        args: [label, dnsEncode(`${label}.eth`)],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      await refresh();
    } catch (e) {
      setError(readable(e));
    } finally {
      setBusy(false);
    }
  }, [label, publicClient, refresh, writeContractAsync]);

  /** Step 2: point the name at it. Only the name's owner can do this. */
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

  return { state, busy, error, create, point, refresh };
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
