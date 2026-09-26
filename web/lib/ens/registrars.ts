import "server-only";
import type { Address } from "viem";
import { getIndexedBranches } from "./indexer";

/**
 * Is this address a registrar belonging to this organization?
 *
 * The write routes take `registrar` from the request body and hand it to `writeContract` as the
 * call target, signed by `ORG_PRIVATE_KEY`. Without this check a caller chooses which contract
 * the organization's root key transacts against — the calldata is ABI-fixed, so the damage is
 * bounded, but "bounded arbitrary signed write" is not a property to ship.
 *
 * Returns the branch it belongs to, so callers can also stop trusting a client-supplied branch
 * name: keying an enforcer row on `<label>.<branch the caller claimed>` let one branch's
 * onboarding repoint another branch's member.
 */
export async function branchForRegistrar(
  registrar: string,
): Promise<{ name: string; label: string; registry: Address } | null> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(registrar)) return null;
  const target = registrar.toLowerCase();

  const branches = await getIndexedBranches();
  const match = branches.find((b) => b.registrar?.toLowerCase() === target);
  if (!match) return null;
  return { name: match.name, label: match.label, registry: match.registry as Address };
}
