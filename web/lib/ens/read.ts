import "server-only";
import {
  createPublicClient,
  http,
  keccak256,
  namehash,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { sepolia } from "viem/chains";
import { branchFactoryAbi, orgRegistrarAbi, registrarV2Abi, registryAbi, resolverAbi } from "./abis";
import { ENS, ENTITLEMENT_KEYS, RPC_URL } from "./config";
import { getIndexedBranches, getIndexedMemberships } from "./indexer";

/**
 * Reads the ENSCA contracts directly. Server-side only, so viem never reaches the client bundle.
 *
 * This is the identity half of the console: the registry is the source of truth for who holds a
 * membership and the resolver for what it grants. The proxy remains the source of truth for
 * sessions and bytes — the two answer different questions and neither substitutes for the other.
 */

// `batch` collapses the concurrent reads below into single JSON-RPC batch requests, and
// `multicall` aggregates eth_call through Multicall3 — the per-membership reads dominate latency
// otherwise, since each one is its own round trip to a public node.
const client = createPublicClient({
  chain: sepolia,
  transport: http(RPC_URL, { batch: { wait: 8 } }),
  batch: { multicall: { wait: 8 } },
});

/** Role names change only when an organization edits its catalogue. */
const roleNameCache = new Map<string, { at: number; names: Map<string, string> }>();

const labelHash = (label: string) => BigInt(keccak256(toHex(label)));
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export type RoleInfo = {
  id: Hex;
  name: string;
  canOnboard: boolean;
  openToOnboarders: boolean;
  active: boolean;
  registryBitmap: string;
  entitlements: { key: string; value: string }[];
};

export type MembershipSource = "indexer" | "chain";

export type EnsMembership = {
  label: string;
  name: string;
  /** Which branch this membership belongs to. */
  branch: string;
  branchLabel: string;
  owner: Address;
  role: string;
  /** Registry bitmap the holder has over their own name; "0" means they cannot edit it. */
  ownRoles: string;
  /** The Member name that survives this membership, if the wallet has one. */
  memberName: string | null;
  entitlements: Record<string, string>;
};

export type MembershipsResult = {
  memberships: EnsMembership[];
  /** Which path produced the rows, so the console can say so rather than imply freshness. */
  source: MembershipSource;
};

export type EnsBranch = {
  organization: string;
  branch: string;
  expiry: number;
  open: boolean;
  registry: Address;
  registrar: Address;
  resolver: Address;
  roles: RoleInfo[];
};

/**
 * Role names, recovered from `RoleDefined` logs.
 *
 * A role id is `keccak256(name)`, which is one-way — so the readable name has to come from the
 * event. This is also what makes org-defined roles work in the UI: a role the contract never
 * heard of shows up here the moment it is defined.
 */
async function roleNames(registrar: Address): Promise<Map<string, string>> {
  const cached = roleNameCache.get(registrar);
  if (cached && Date.now() - cached.at < 60_000) return cached.names;

  // Read from state, not from event logs. The registrar stores each group's readable name
  // against its id, so this is one call at any chain height — where scanning `RoleDefined`
  // meant an `eth_getLogs` range that grows by a block every twelve seconds until whichever
  // provider is in use refuses it, and then reports "no groups" rather than an error.
  const roleNameList = (await client.readContract({
    address: registrar,
    abi: registrarV2Abi,
    functionName: "allRoleNames",
  })) as string[];

  const names = new Map<string, string>();
  for (const name of roleNameList) {
    names.set(keccak256(toHex(name)).toLowerCase(), name);
  }
  roleNameCache.set(registrar, { at: Date.now(), names });
  return names;
}

export async function getRoles(registrar: Address = ENS.branchRegistrar as Address): Promise<RoleInfo[]> {
  const names = await roleNames(registrar);

  return Promise.all(
    [...names.entries()].map(async ([id, name]) => {
      const [spec, entitlements] = await Promise.all([
        client.readContract({
          address: registrar,
          abi: registrarV2Abi,
          functionName: "roleSpec",
          args: [id as Hex],
        }),
        client.readContract({
          address: registrar,
          abi: registrarV2Abi,
          functionName: "entitlementsOf",
          args: [id as Hex],
        }),
      ]);

      const [registryBitmap, canOnboard, openToOnboarders, active] = spec;
      return {
        id: id as Hex,
        name,
        canOnboard,
        openToOnboarders,
        active,
        registryBitmap: registryBitmap.toString(),
        entitlements: entitlements.map((e) => ({ key: e.key, value: e.value })),
      } satisfies RoleInfo;
    }),
  );
}

export async function getBranch(): Promise<EnsBranch> {
  const [expiry, roles] = await Promise.all([
    client.readContract({
      address: ENS.orgRegistry as Address,
      abi: registryAbi,
      functionName: "getExpiry",
      args: [labelHash(ENS.branchLabel)],
    }),
    getRoles(),
  ]);

  const expirySeconds = Number(expiry);
  return {
    organization: ENS.organization,
    branch: ENS.branch,
    expiry: expirySeconds,
    open: expirySeconds * 1000 > Date.now(),
    registry: ENS.branchRegistry as Address,
    registrar: ENS.branchRegistrar as Address,
    resolver: ENS.resolver as Address,
    roles,
  };
}

/**
 * Live memberships in the branch.
 *
 * Built from `Onboarded` logs, then re-checked against the registry so anything revoked or expired
 * drops out. This is what an indexer would do; ENS's own Sepolia v2 instance is down, and reading
 * logs keeps the console honest about on-chain state regardless.
 */
export async function getMemberships(branchLabel?: string): Promise<MembershipsResult> {
  // No fallback. There used to be one and it ignored `branchLabel` entirely — asking for Osaka
  // during an indexer outage returned Tokyo's members, stamped "tokyo", with HTTP 200. A
  // confident wrong answer is worse than the 502 the caller now gets and can report.
  return { memberships: await fromIndexer(branchLabel), source: "indexer" };
}

/**
 * One GraphQL round trip for names, owners and entitlements; contract reads only for the parts
 * that live in our own contracts and no ENS indexer can know.
 */
async function fromIndexer(branchLabel?: string): Promise<EnsMembership[]> {
  const [indexed, branches] = await Promise.all([
    getIndexedMemberships(branchLabel),
    getIndexedBranches(),
  ]);

  const byLabel = new Map(branches.map((b) => [b.label, b]));
  // Role names are per-branch, because each branch has its own registrar and catalogue.
  const nameMaps = new Map<string, Map<string, string>>();
  await Promise.all(
    branches
      .filter((b) => b.registrar)
      .map(async (b) => nameMaps.set(b.label, await roleNames(b.registrar as Address))),
  );

  return Promise.all(
    indexed.map(async ({ label, name, owner, entitlements, branch, branchLabel: bl }) => {
      const b = byLabel.get(bl);
      const names = nameMaps.get(bl) ?? new Map<string, string>();

      // Without a published registrar the chain-only fields cannot be read; the indexed ones
      // still are, so the row appears with those columns blank rather than being dropped.
      if (!b?.registrar) {
        return {
          label, name, branch, branchLabel: bl,
          owner: owner as Address,
          role: "unknown", ownRoles: "0", memberName: null, entitlements,
        } satisfies EnsMembership;
      }

      const resource = await client.readContract({
        address: b.registry as Address,
        abi: registryAbi,
        functionName: "getResource",
        args: [labelHash(label)],
      });

      const [roleId, ownRoles, memberLabel] = await Promise.all([
        client.readContract({
          address: b.registrar as Address,
          abi: registrarV2Abi,
          functionName: "roleOf",
          args: [resource],
        }),
        client.readContract({
          address: b.registry as Address,
          abi: registryAbi,
          functionName: "roles",
          args: [resource, owner as Address],
        }),
        client.readContract({
          address: ENS.orgRegistrar as Address,
          abi: orgRegistrarAbi,
          functionName: "labelOf",
          args: [owner as Address],
        }),
      ]);

      return {
        label, name, branch, branchLabel: bl,
        owner: owner as Address,
        // A role id is keccak256(name); only that branch's RoleDefined event has the readable name.
        role: names.get(roleId.toLowerCase()) ?? "unknown",
        ownRoles: ownRoles.toString(),
        memberName: memberLabel ? `${memberLabel}.${ENS.organization}` : null,
        entitlements,
      } satisfies EnsMembership;
    }),
  );
}

export type ResolvedIdentity = {
  name: string;
  owner: Address;
  branch: string;
  role: string;
  /** Entitlement records as published on the resolver. */
  entitlements: Record<string, string>;
  source: MembershipSource;
};

/**
 * Resolve one membership name to the policy an enforcer should apply.
 *
 * Reads the contracts directly and only for this name — never the indexer, and never the whole
 * membership list. Two reasons, both of which matter at admission time:
 *
 *   1. **A partial answer must never look like a deny.** Searching a list and coming up empty is
 *      indistinguishable from "no such membership", so an indexer outage or a branch missing from
 *      the fallback would silently lock people out. Here a failed read throws, the route answers
 *      502, and the caller falls back instead of denying.
 *   2. It is O(1) rather than O(memberships), which is what a hot path needs.
 *
 * Returns `null` only when the chain positively says there is no live membership.
 */
export async function resolveIdentity(name: string): Promise<ResolvedIdentity | null> {
  const lower = name.trim().toLowerCase().replace(/\.$/, "");
  const suffix = `.${ENS.organization}`;
  if (!lower.endsWith(suffix)) return null;

  const parts = lower.slice(0, -suffix.length).split(".");
  // <label>.<branch>.<org> — anything else is not a membership.
  if (parts.length !== 2) return null;
  const [label, branchLabel] = parts;

  // A branch is a name in the org registry that carries a subregistry.
  const branchRegistry = await client.readContract({
    address: ENS.orgRegistry as Address,
    abi: registryAbi,
    functionName: "getSubregistry",
    args: [branchLabel],
  });
  if (branchRegistry === ZERO_ADDRESS) return null;

  const status = await client.readContract({
    address: branchRegistry,
    abi: registryAbi,
    functionName: "getStatus",
    args: [labelHash(label)],
  });
  if (status !== 2) return null; // not REGISTERED — a definite deny

  const branchNode = namehash(`${branchLabel}${suffix}`);
  const [owner, registrarRecord] = await Promise.all([
    client.readContract({
      address: branchRegistry,
      abi: registryAbi,
      functionName: "getOwner",
      args: [labelHash(label)],
    }),
    client.readContract({
      address: ENS.resolver as Address,
      abi: resolverAbi,
      functionName: "text",
      args: [branchNode, "ensca.registrar"],
    }),
  ]);

  const node = namehash(lower);
  const values = await Promise.all(
    ENTITLEMENT_KEYS.map((key) =>
      client.readContract({
        address: ENS.resolver as Address,
        abi: resolverAbi,
        functionName: "text",
        args: [node, key],
      }),
    ),
  );

  // The readable role name lives in that branch's registrar, which the branch publishes itself.
  let role = "unknown";
  if (registrarRecord) {
    const registrar = registrarRecord as Address;
    const [resource, names] = await Promise.all([
      client.readContract({
        address: branchRegistry,
        abi: registryAbi,
        functionName: "getResource",
        args: [labelHash(label)],
      }),
      roleNames(registrar),
    ]);
    const roleId = await client.readContract({
      address: registrar,
      abi: registrarV2Abi,
      functionName: "roleOf",
      args: [resource],
    });
    role = names.get(roleId.toLowerCase()) ?? "unknown";
  }

  return {
    name: lower,
    owner,
    branch: `${branchLabel}${suffix}`,
    role,
    entitlements: Object.fromEntries(
      ENTITLEMENT_KEYS.map((key, i) => [key, values[i]]).filter(([, v]) => v !== ""),
    ),
    source: "chain",
  };
}


/**
 * Which membership does this wallet hold, anywhere in the organization?
 *
 * The portal needs this because a person arriving at the captive page has a wallet, not a name.
 * Asking them to type their own ENS name would be both worse UX and weaker: a typed name proves
 * nothing, which is exactly how the current portal ends up treating a public name as a password.
 *
 * Branches come from the factory's own `BranchCreated` logs, not the indexer. This is the
 * admission path: a person onboarded at the desk must be able to reach the network on the walk
 * to the door, and an indexer that has not caught up would deny them. Logs are visible in the
 * same block the branch is created in.
 */
export async function resolveByWallet(wallet: Address): Promise<ResolvedIdentity | null> {
  const branches = await chainBranches();
  if (branches.length === 0) {
    throw new Error("no branches could be read; cannot rule out a membership");
  }

  for (const branch of branches) {
    const resource = await client.readContract({
      address: branch.registrar as Address,
      abi: registrarV2Abi,
      functionName: "membershipOf",
      args: [wallet],
    });
    if (resource === 0n) continue;

    const label = await client.readContract({
      address: branch.registrar as Address,
      abi: registrarV2Abi,
      functionName: "labelOf",
      args: [resource],
    });
    if (!label) continue;

    // Round-trip through the name so the answer is exactly what an enforcer would resolve.
    return await resolveIdentity(`${label}.${branch.name}`);
  }
  return null;
}

/**
 * Every branch this organization has opened, read from the factory's logs.
 *
 * The indexer is the nicer source — one query, entitlements included — but it is a cache, and
 * on the admission path a cache miss is indistinguishable from "not a member". `BranchCreated`
 * carries the label, the registry and the registrar, so no follow-up read is needed to know
 * where to look.
 */
export type ChainBranch = {
  name: string;
  label: string;
  registrar: Address;
  registry: Address;
};

let chainBranchCache: { at: number; branches: ChainBranch[] } | null = null;

export async function chainBranches(): Promise<ChainBranch[]> {
  // Cached: this is reached from an unauthenticated endpoint, and the scan is O(blocks) with no
  // upper bound. Branches are created a handful of times in an organization's life.
  if (chainBranchCache && Date.now() - chainBranchCache.at < 30_000) {
    return chainBranchCache.branches;
  }

  // The factory keeps the list; no log scan, and no growing block range to be refused.
  const labels = (await client.readContract({
    address: ENS.branchFactory as Address,
    abi: branchFactoryAbi,
    functionName: "allBranchLabels",
  })) as string[];

  const byLabel = new Map<string, { registrar: Address; registry: Address }>();
  await Promise.all(
    labels.map(async (label) => {
      const registry = (await client.readContract({
        address: ENS.orgRegistry as Address,
        abi: registryAbi,
        functionName: "getSubregistry",
        args: [label],
      })) as Address;
      if (registry === ZERO_ADDRESS) return;

      // The registrar is published as a text record precisely so it is discoverable.
      const published = (await client.readContract({
        address: ENS.resolver as Address,
        abi: resolverAbi,
        functionName: "text",
        args: [namehash(`${label}.${ENS.organization}`), "ensca.registrar"],
      })) as string;
      if (!/^0x[0-9a-fA-F]{40}$/.test(published)) return;

      byLabel.set(label, { registrar: published as Address, registry });
    }),
  );
  const branches = [...byLabel]
    .map(([label, { registrar, registry }]) => ({
      name: `${label}.${ENS.organization}`,
      label,
      registrar,
      registry,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  chainBranchCache = { at: Date.now(), branches };
  return branches;
}
