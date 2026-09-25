import { createPublicClient, http, keccak256, namehash, toHex, type Address } from "viem";
import { sepolia } from "viem/chains";
import { registrarAbi, registryAbi, resolverAbi } from "./abis";
import { DEPLOYMENT, ROLE_NAMES, RPC_URL, type OnChainRole } from "./config";

/**
 * Reads the live branch straight from ENSv2 on Sepolia.
 *
 * There is no database here on purpose: the registry is the source of truth for who holds a
 * membership, and the resolver is the source of truth for what that membership grants. The
 * console just reads them — the same thing an enforcer does at admission time.
 */

/**
 * ENS calls these the "dangerous" roles: held on ROOT_RESOURCE they reach every name in the
 * registry. A registry is emancipated once none of them has an assignee.
 *
 * Computed here rather than via `isEmancipated()`, which the docs describe but the deployed
 * Sepolia beta build does not expose — calling it reverts. `roleCount` packs an assignee count
 * into the nybble at each role's bit position, so the check is a mask against those nybbles.
 */
const DANGEROUS_ROLE_BITS = [12n, 20n, 24n, 124n]; // UNREGISTER, SET_SUBREGISTRY, SET_RESOLVER, UPGRADE
const DANGEROUS_MASK = DANGEROUS_ROLE_BITS.reduce(
  (mask, bit) => mask | (0xfn << bit) | (0xfn << (bit + 128n)),
  0n,
);

export const publicClient = createPublicClient({
  chain: sepolia,
  transport: http(RPC_URL),
});

const labelHash = (label: string) => BigInt(keccak256(toHex(label)));

export type BranchSummary = {
  organization: string;
  branch: string;
  venue: string;
  expiry: number;
  /** True while the branch window is open. */
  open: boolean;
  registry: Address;
  registrar: Address;
  resolver: Address;
  emancipated: boolean;
};

export type MembershipRow = {
  label: string;
  name: string;
  owner: Address;
  resource: bigint;
  role: OnChainRole;
  /** Registry role bitmap the holder has over their own name. `0n` means they cannot edit it. */
  ownRoles: bigint;
  entitlements: Record<string, string>;
};

const ENTITLEMENT_KEYS = ["role", "wifi.group", "wifi.rate", "wifi.ceil"] as const;

export async function getBranch(): Promise<BranchSummary> {
  const [expiry, rootRoleCounts] = await Promise.all([
    publicClient.readContract({
      address: DEPLOYMENT.orgRegistry as Address,
      abi: registryAbi,
      functionName: "getExpiry",
      args: [labelHash(DEPLOYMENT.branchLabel)],
    }),
    publicClient.readContract({
      address: DEPLOYMENT.branchRegistry as Address,
      abi: registryAbi,
      functionName: "roleCount",
      args: [0n], // ROOT_RESOURCE
    }),
  ]);

  const expirySeconds = Number(expiry);
  return {
    organization: DEPLOYMENT.organization,
    branch: DEPLOYMENT.branch,
    venue: "Sepolia · ENSv2 beta",
    expiry: expirySeconds,
    open: expirySeconds * 1000 > Date.now(),
    registry: DEPLOYMENT.branchRegistry as Address,
    registrar: DEPLOYMENT.branchRegistrar as Address,
    resolver: DEPLOYMENT.resolver as Address,
    emancipated: (rootRoleCounts & DANGEROUS_MASK) === 0n,
  };
}

/**
 * Every live membership in the branch.
 *
 * Built from `Onboarded` logs rather than an index, then re-checked against the registry so
 * anything revoked or expired drops out. The ENSv2 indexer would do this for us, but its Sepolia
 * instance is down, and reading logs keeps the console honest about on-chain state either way.
 */
export async function getMemberships(): Promise<MembershipRow[]> {
  const logs = await publicClient.getContractEvents({
    address: DEPLOYMENT.branchRegistrar as Address,
    abi: registrarAbi,
    eventName: "Onboarded",
    fromBlock: DEPLOYMENT.deployedAtBlock,
    toBlock: "latest",
  });

  const seen = new Map<string, { label: string; owner: Address }>();
  for (const log of logs) {
    const { label, owner } = log.args as { label?: string; owner?: Address };
    if (label && owner) seen.set(label, { label, owner });
  }

  const rows = await Promise.all(
    [...seen.values()].map(async ({ label, owner }) => {
      const status = await publicClient.readContract({
        address: DEPLOYMENT.branchRegistry as Address,
        abi: registryAbi,
        functionName: "getStatus",
        args: [labelHash(label)],
      });
      if (status !== 2) return null; // 2 = REGISTERED; anything else was revoked or expired

      const resource = await publicClient.readContract({
        address: DEPLOYMENT.branchRegistry as Address,
        abi: registryAbi,
        functionName: "getResource",
        args: [labelHash(label)],
      });

      const [roleOrdinal, ownRoles, entitlements] = await Promise.all([
        publicClient.readContract({
          address: DEPLOYMENT.branchRegistrar as Address,
          abi: registrarAbi,
          functionName: "roleOf",
          args: [resource],
        }),
        publicClient.readContract({
          address: DEPLOYMENT.branchRegistry as Address,
          abi: registryAbi,
          functionName: "roles",
          args: [resource, owner],
        }),
        getEntitlements(label),
      ]);

      return {
        label,
        name: `${label}.${DEPLOYMENT.branch}`,
        owner,
        resource,
        role: ROLE_NAMES[roleOrdinal] ?? "none",
        ownRoles,
        entitlements,
      } satisfies MembershipRow;
    }),
  );

  return rows.filter((row): row is MembershipRow => row !== null);
}

/** Entitlement text records, read from the branch resolver by full ENS namehash. */
export async function getEntitlements(label: string): Promise<Record<string, string>> {
  const node = namehash(`${label}.${DEPLOYMENT.branch}`);
  const values = await Promise.all(
    ENTITLEMENT_KEYS.map((key) =>
      publicClient.readContract({
        address: DEPLOYMENT.resolver as Address,
        abi: resolverAbi,
        functionName: "text",
        args: [node, key],
      }),
    ),
  );
  return Object.fromEntries(
    ENTITLEMENT_KEYS.map((key, i) => [key, values[i]]).filter(([, v]) => v !== ""),
  );
}
