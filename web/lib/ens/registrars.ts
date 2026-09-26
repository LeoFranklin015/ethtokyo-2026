import "server-only";
import {
  CallExecutionError,
  ContractFunctionExecutionError,
  createPublicClient,
  http,
  type Address,
} from "viem";
import { sepolia } from "viem/chains";
import { registrarV2Abi, registryAbi } from "./abis";
import { ENS, RPC_BATCH_SIZE, RPC_URL } from "./config";

const client = createPublicClient({ chain: sepolia, transport: http(RPC_URL, { batch: { batchSize: RPC_BATCH_SIZE, wait: 8 } }) });

/**
 * Is this address a registrar belonging to this organization?
 *
 * The write routes take `registrar` from the request body and hand it to `writeContract` as the
 * call target, signed by `ORG_PRIVATE_KEY`. Without this check a caller chooses which contract
 * the organization's root key transacts against.
 *
 * Verified entirely on chain, never through the indexer. A branch created seconds ago is not
 * indexed yet, so an indexer-backed check would refuse every write to a brand-new branch — the
 * create flow would break at exactly the moment it is meant to work.
 *
 * The proof is a round trip: the registrar names its own branch, that name must resolve to a
 * subregistry the organization actually points at, and that subregistry must be the registry the
 * registrar claims to serve. A contract that satisfies all three is ours.
 */
export async function branchForRegistrar(
  registrar: string,
): Promise<{ name: string; label: string; registry: Address } | null> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(registrar)) return null;
  const address = registrar as Address;

  let dnsName: `0x${string}`;
  let registry: Address;
  try {
    [dnsName, registry] = await Promise.all([
      client.readContract({ address, abi: registrarV2Abi, functionName: "BRANCH_DNS_NAME" }),
      client.readContract({ address, abi: registrarV2Abi, functionName: "REGISTRY" }),
    ]);
  } catch (error) {
    // A contract that does not answer this interface is a definite "not one of ours" — a deny,
    // not an outage. A network failure still throws, so the caller can tell them apart and
    // return 502 rather than accusing a real registrar of being foreign.
    if (error instanceof ContractFunctionExecutionError || error instanceof CallExecutionError) {
      return null;
    }
    throw error;
  }

  // First DNS label: one length byte, then that many bytes.
  const bytes = Buffer.from(dnsName.slice(2), "hex");
  if (bytes.length === 0) return null;
  const labelLength = bytes[0]!;
  if (labelLength === 0 || bytes.length < 1 + labelLength) return null;
  const label = bytes.subarray(1, 1 + labelLength).toString("utf8");
  if (!/^[a-z0-9-]{1,32}$/.test(label)) return null;

  const claimed = await client.readContract({
    address: ENS.orgRegistry as Address,
    abi: registryAbi,
    functionName: "getSubregistry",
    args: [label],
  });
  if (claimed.toLowerCase() !== (registry as string).toLowerCase()) return null;

  return { name: `${label}.${ENS.organization}`, label, registry: registry as Address };
}
