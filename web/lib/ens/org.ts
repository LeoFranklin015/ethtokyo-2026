import "server-only";
import { createPublicClient, http, keccak256, toHex, type Address, type Hex } from "viem";
import { sepolia } from "viem/chains";
import { orgFactoryAbi, registryAbi } from "./abis";
import { ENS, RPC_BATCH_SIZE, RPC_URL } from "./config";

/**
 * Which contracts belong to which organization.
 *
 * Every organization is four contracts under a `.eth` name its owner holds, and the `OrgFactory`
 * records what it built. So "what is `acme.eth`?" is a single read, and nothing in this codebase
 * needs to know an organization's name ahead of time.
 *
 * This replaces a block of constants naming one organization. The failure that produced was
 * quiet rather than loud: a console pointed at somebody else's name answered every question
 * confidently and wrongly — listing their branches, their groups, their members.
 */

const client = createPublicClient({
  chain: sepolia,
  transport: http(RPC_URL, { batch: { batchSize: RPC_BATCH_SIZE, wait: 8 } }),
});

export type Organization = {
  /** `acme` */
  label: string;
  /** `acme.eth` */
  name: string;
  registry: Address;
  resolver: Address;
  orgRegistrar: Address;
  branchFactory: Address;
  node: Hex;
};

const ZERO = "0x0000000000000000000000000000000000000000";

/** Organizations change rarely; their addresses never do. */
const cache = new Map<string, { at: number; org: Organization | null }>();
const TTL = 60_000;

/**
 * Look up an organization by its `.eth` label.
 *
 * `null` means no organization has been set up for that name — a definite answer. A throw means
 * we could not find out, which callers must not turn into "it does not exist".
 */
export async function resolveOrg(label: string): Promise<Organization | null> {
  const clean = label.trim().toLowerCase().replace(/\.eth$/, "");
  if (!/^[a-z0-9-]{1,32}$/.test(clean)) return null;

  const hit = cache.get(clean);
  if (hit && Date.now() - hit.at < TTL) return hit.org;

  const found = (await client.readContract({
    address: ENS.orgFactory as Address,
    abi: orgFactoryAbi,
    functionName: "organizationFor",
    args: [clean],
  })) as {
    registry: Address;
    resolver: Address;
    orgRegistrar: Address;
    branchFactory: Address;
    node: Hex;
  };

  const org: Organization | null =
    found.registry === ZERO
      ? null
      : { label: clean, name: `${clean}.eth`, ...found };

  cache.set(clean, { at: Date.now(), org });
  return org;
}

/**
 * The organization a membership name belongs to.
 *
 * `leo.tokyo.acme.eth` → `acme.eth`. Derived from the name itself rather than compared against a
 * configured suffix, which is what made the admission path refuse every name the moment the
 * console was pointed at a different organization.
 */
export async function orgForName(name: string): Promise<{
  org: Organization;
  branchLabel: string;
  label: string;
} | null> {
  const parts = name.trim().toLowerCase().replace(/\.$/, "").split(".");
  // <label>.<branch>.<org>.eth — anything else is not a membership.
  if (parts.length !== 4 || parts[3] !== "eth") return null;

  const org = await resolveOrg(parts[2]!);
  if (!org) return null;
  return { org, branchLabel: parts[1]!, label: parts[0]! };
}

/**
 * Is this `.eth` name set up as an organization, and who owns it?
 *
 * Used to show somebody their own names and which of them are ready to build on.
 */
export async function orgStatus(label: string): Promise<{
  label: string;
  name: string;
  owner: Address | null;
  organization: Organization | null;
}> {
  const clean = label.trim().toLowerCase().replace(/\.eth$/, "");
  const [owner, organization] = await Promise.all([
    client
      .readContract({
        address: ENS.ethRegistry as Address,
        abi: registryAbi,
        functionName: "getOwner",
        args: [BigInt(labelHash(clean))],
      })
      .catch(() => null) as Promise<Address | null>,
    resolveOrg(clean).catch(() => null),
  ]);

  return {
    label: clean,
    name: `${clean}.eth`,
    owner: owner && owner !== ZERO ? owner : null,
    organization,
  };
}

/** Kept local so this module has no dependency on the read layer, which depends on it. */
function labelHash(label: string): Hex {
  return keccak256(toHex(label));
}
