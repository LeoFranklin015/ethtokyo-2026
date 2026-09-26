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
import { orgRegistrarAbi, registrarV2Abi, registryAbi, resolverAbi } from "./abis";
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

  const logs = await client.getContractEvents({
    address: registrar,
    abi: registrarV2Abi,
    eventName: "RoleDefined",
    fromBlock: ENS.fromBlock,
    toBlock: "latest",
  });

  const names = new Map<string, string>();
  for (const log of logs) {
    const { roleId, name } = log.args as { roleId?: Hex; name?: string };
    if (roleId && name) names.set(roleId.toLowerCase(), name);
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
  try {
    return { memberships: await fromIndexer(branchLabel), source: "indexer" };
  } catch {
    // The indexer is a cache, never the authority. If it is unreachable or lagging behind a
    // deploy, fall through to reading the contracts directly rather than showing nothing.
    return { memberships: await fromChain(), source: "chain" };
  }
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

async function fromChain(): Promise<EnsMembership[]> {
  const [logs, names] = await Promise.all([
    client.getContractEvents({
      address: ENS.branchRegistrar as Address,
      abi: registrarV2Abi,
      eventName: "Onboarded",
      fromBlock: ENS.fromBlock,
      toBlock: "latest",
    }),
    roleNames(ENS.branchRegistrar as Address),
  ]);

  const seen = new Map<string, Address>();
  for (const log of logs) {
    const { label, owner } = log.args as { label?: string; owner?: Address };
    if (label && owner) seen.set(label, owner);
  }

  const rows = await Promise.all(
    [...seen.entries()].map(async ([label, owner]): Promise<EnsMembership | null> => {
      const status = await client.readContract({
        address: ENS.branchRegistry as Address,
        abi: registryAbi,
        functionName: "getStatus",
        args: [labelHash(label)],
      });
      if (status !== 2) return null; // 2 = REGISTERED

      const resource = await client.readContract({
        address: ENS.branchRegistry as Address,
        abi: registryAbi,
        functionName: "getResource",
        args: [labelHash(label)],
      });

      const [roleId, ownRoles, node, memberLabel] = await Promise.all([
        client.readContract({
          address: ENS.branchRegistrar as Address,
          abi: registrarV2Abi,
          functionName: "roleOf",
          args: [resource],
        }),
        client.readContract({
          address: ENS.branchRegistry as Address,
          abi: registryAbi,
          functionName: "roles",
          args: [resource, owner],
        }),
        client.readContract({
          address: ENS.branchRegistrar as Address,
          abi: registrarV2Abi,
          functionName: "membershipNode",
          args: [label],
        }),
        client.readContract({
          address: ENS.orgRegistrar as Address,
          abi: orgRegistrarAbi,
          functionName: "labelOf",
          args: [owner],
        }),
      ]);

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

      return {
        label,
        name: `${label}.${ENS.branch}`,
        branch: ENS.branch,
        branchLabel: ENS.branchLabel,
        owner,
        role: names.get(roleId.toLowerCase()) ?? "unknown",
        ownRoles: ownRoles.toString(),
        memberName: memberLabel ? `${memberLabel}.${ENS.organization}` : null,
        entitlements: Object.fromEntries(
          ENTITLEMENT_KEYS.map((key, i) => [key, values[i]]).filter(([, v]) => v !== ""),
        ),
      } satisfies EnsMembership;
    }),
  );

  return rows.filter((row): row is EnsMembership => row !== null);
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
 * Reads contracts directly, never the indexer — this is on the admission path, and an indexer
 * that is merely lagging must not read as "not a member".
 */
export async function resolveByWallet(wallet: Address): Promise<ResolvedIdentity | null> {
  const branches = await getIndexedBranches();

  for (const branch of branches) {
    if (!branch.registrar) continue;
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
