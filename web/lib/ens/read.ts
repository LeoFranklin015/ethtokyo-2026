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
import { listEnsCandidates } from "../enforcer/ens-names";
import { ENTITLEMENT_KEYS, MEMBERSHIP_TEXT_KEYS, RPC_BATCH_SIZE, RPC_URL } from "./config";
import { getIndexedBranches, getIndexedMemberships, getIndexerStatus } from "./indexer";
import { orgForName, resolveOrg, type Organization } from "./org";

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
  transport: http(RPC_URL, { batch: { batchSize: RPC_BATCH_SIZE, wait: 8 } }),
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
  let roleNameList: string[];
  try {
    roleNameList = (await client.readContract({
      address: registrar,
      abi: registrarV2Abi,
      functionName: "allRoleNames",
    })) as string[];
  } catch {
    // Registrars deployed before the catalogue was stored on chain have no such function, and
    // the call reverts. Their names only ever existed in `RoleDefined` events, so there is
    // nothing to read — an empty catalogue is the honest answer, and it does not take the
    // whole membership list down with it the way a thrown error did.
    roleNameList = [];
  }

  const names = new Map<string, string>();
  for (const name of roleNameList) {
    names.set(keccak256(toHex(name)).toLowerCase(), name);
  }
  roleNameCache.set(registrar, { at: Date.now(), names });
  return names;
}

export async function getRoles(registrar: Address): Promise<RoleInfo[]> {
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

/**
 * How far behind the chain the indexer is, in blocks.
 *
 * `null` when either side could not be read. Anything that presents indexed data as settled
 * fact needs this: a stale index does not report itself as stale, it reports an empty list, and
 * an empty list is indistinguishable from "there is nobody" unless you ask how old it is.
 */
export async function indexerLag(indexedBlock: number | null): Promise<number | null> {
  if (indexedBlock === null) return null;
  try {
    const head = await client.getBlockNumber();
    return Math.max(0, Number(head) - indexedBlock);
  } catch {
    return null;
  }
}

/** A handful of blocks behind is ordinary indexing delay; beyond that the index is not evidence. */
export const STALE_AFTER_BLOCKS = 30;

/**
 * Live memberships in the branch.
 *
 * Still index-first, because nothing on chain enumerates the members of a branch: the registrar
 * emits `Onboarded` but keeps no list, and scanning for those logs means an `eth_getLogs` range
 * that grows by a block every twelve seconds until a provider refuses it — which is how this
 * once reported "no members" during an outage rather than an error.
 *
 * What it now has instead is a *list of names to check*. The console records every name it
 * writes, and when the index is empty or behind, each recorded name for this branch is put to
 * the registry: registered, owned by whom, in which group. Only what the chain confirms is
 * returned, so a stale or wrong row in that list cannot put a phantom member on screen — the
 * list decides what is asked about, never what is answered.
 *
 * The fallback that used to live here ignored `branchLabel` entirely and answered a question
 * about Osaka with Tokyo's members, stamped "tokyo", at HTTP 200. `branchLabel` is therefore
 * carried into the candidate query and checked again on every row that comes back.
 */
export async function getMemberships(
  organization: string,
  branchLabel?: string,
  orgRegistrar?: Address,
): Promise<MembershipsResult> {
  const [indexed, status] = await Promise.all([
    fromIndexer(organization, branchLabel, orgRegistrar),
    getIndexerStatus(),
  ]);
  const lag = await indexerLag(status?.block ?? null);
  const stale = lag === null || lag > STALE_AFTER_BLOCKS;
  if (indexed.length > 0 && !stale) return { memberships: indexed, source: "indexer" };

  const verified = await fromCandidates(organization, branchLabel, orgRegistrar);
  if (verified.length === 0) return { memberships: indexed, source: "indexer" };

  // Indexed rows the chain was never asked about are kept — a member onboarded from another
  // console is real and is not in our candidate list — but a name the chain has just answered
  // for wins, because that answer is the newer one.
  const byName = new Map(indexed.map((m) => [m.name, m]));
  for (const m of verified) byName.set(m.name, m);
  return { memberships: [...byName.values()], source: "chain" };
}

/**
 * Verify the names this console has written, one by one, against the registry.
 *
 * A candidate is dropped unless `getStatus` says REGISTERED, which is the same test the
 * admission path applies — so a revoked member, a name recorded for a transaction that reverted,
 * and a row left behind by a branch that no longer exists all disappear here rather than being
 * shown. Everything returned is read from the chain in this request; nothing is remembered
 * except which names were worth asking about.
 */
async function fromCandidates(
  organization: string,
  branchLabel?: string,
  orgRegistrar?: Address,
): Promise<EnsMembership[]> {
  const org = await resolveOrg(organization).catch(() => null);
  if (!org) return [];

  const candidates = await listEnsCandidates(org.label, "membership", branchLabel);
  if (candidates.length === 0) return [];

  const branches = new Map((await chainBranches(org)).map((b) => [b.label, b]));

  const rows = await Promise.all(
    candidates.map(async (candidate) => {
      const bl = candidate.branch_label;
      // The enforcer already filtered on this; checked again because getting it wrong is the
      // specific failure this whole path exists to not repeat.
      if (!bl || (branchLabel && bl !== branchLabel)) return null;
      const branch = branches.get(bl);
      if (!branch) return null;

      const token = labelHash(candidate.label);
      const status = await client.readContract({
        address: branch.registry,
        abi: registryAbi,
        functionName: "getStatus",
        args: [token],
      });
      if (status !== 2) return null;

      const [owner, resource, names] = await Promise.all([
        client.readContract({
          address: branch.registry,
          abi: registryAbi,
          functionName: "getOwner",
          args: [token],
        }),
        client.readContract({
          address: branch.registry,
          abi: registryAbi,
          functionName: "getResource",
          args: [token],
        }),
        roleNames(branch.registrar),
      ]);
      if (owner === ZERO_ADDRESS) return null;

      const node = namehash(candidate.name);
      const [roleId, ownRoles, memberLabel, texts] = await Promise.all([
        client.readContract({
          address: branch.registrar,
          abi: registrarV2Abi,
          functionName: "roleOf",
          args: [resource],
        }),
        client.readContract({
          address: branch.registry,
          abi: registryAbi,
          functionName: "roles",
          args: [resource, owner],
        }),
        orgRegistrar
          ? client.readContract({
              address: orgRegistrar,
              abi: orgRegistrarAbi,
              functionName: "labelOf",
              args: [owner],
            })
          : Promise.resolve(""),
        Promise.all(
          ENTITLEMENT_KEYS.map((key) =>
            client.readContract({
              address: org.resolver,
              abi: resolverAbi,
              functionName: "text",
              args: [node, key],
            }),
          ),
        ),
      ]);

      return {
        label: candidate.label,
        name: candidate.name,
        branch: branch.name,
        branchLabel: bl,
        owner,
        role: names.get(roleId.toLowerCase()) ?? "unknown",
        ownRoles: ownRoles.toString(),
        memberName: memberLabel ? `${memberLabel}.${organization}` : null,
        // Empty is absent, as on the resolver: a record nobody wrote reads as "".
        entitlements: Object.fromEntries(
          ENTITLEMENT_KEYS.map((key, i) => [key, texts[i]!]).filter(([, v]) => v !== ""),
        ),
      } satisfies EnsMembership;
    }),
  );

  return rows.filter((row): row is EnsMembership => row !== null);
}

/**
 * One GraphQL round trip for names, owners and entitlements; contract reads only for the parts
 * that live in our own contracts and no ENS indexer can know.
 */
async function fromIndexer(
  organization: string,
  branchLabel?: string,
  orgRegistrar?: Address,
): Promise<EnsMembership[]> {
  const [indexed, branches] = await Promise.all([
    getIndexedMemberships(organization, branchLabel),
    getIndexedBranches(organization),
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
        orgRegistrar
          ? client.readContract({
              address: orgRegistrar,
              abi: orgRegistrarAbi,
              functionName: "labelOf",
              args: [owner as Address],
            })
          : Promise.resolve(""),
      ]);

      return {
        label, name, branch, branchLabel: bl,
        owner: owner as Address,
        // A role id is keccak256(name); only that branch's RoleDefined event has the readable name.
        role: names.get(roleId.toLowerCase()) ?? "unknown",
        ownRoles: ownRoles.toString(),
        memberName: memberLabel ? `${memberLabel}.${organization}` : null,
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
  /** The member's own name from the `name` record, or null where none was written. */
  displayName: string | null;
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

  // Which organization is this? Derived from the name, not compared against a configured one —
  // that comparison is what made the admission path refuse every name belonging to anybody
  // else's organization, which is every organization but ours.
  const resolved = await orgForName(lower);
  if (!resolved) return null;
  const { org, branchLabel, label } = resolved;
  const suffix = `.${org.name}`;

  // A branch is a name in the org registry that carries a subregistry.
  const branchRegistry = await client.readContract({
    address: org.registry,
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
      address: org.resolver,
      abi: resolverAbi,
      functionName: "text",
      args: [branchNode, "ensca.registrar"],
    }),
  ]);

  const node = namehash(lower);
  const values = await Promise.all(
    MEMBERSHIP_TEXT_KEYS.map((key) =>
      client.readContract({
        address: org.resolver,
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

  const text = Object.fromEntries(MEMBERSHIP_TEXT_KEYS.map((key, i) => [key, values[i]]));

  return {
    name: lower,
    owner,
    branch: `${branchLabel}${suffix}`,
    role,
    // Empty is absent: the resolver answers "" for a record nobody wrote, and a caller must be
    // able to tell that from a record deliberately set, so it is dropped rather than carried.
    displayName: text.name || null,
    entitlements: Object.fromEntries(
      ENTITLEMENT_KEYS.map((key) => [key, text[key]]).filter(([, v]) => v !== ""),
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
export async function resolveByWallet(
  wallet: Address,
  org: Organization,
): Promise<ResolvedIdentity | null> {
  const branches = await chainBranches(org);
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
 * Which membership carries this badge id, anywhere in the organization?
 *
 * A badge carries the five-character label and nothing else — not the branch it was issued at —
 * so every branch is asked and the first registered answer is the member. Labels are unique
 * within a branch but not across them, so the branch order decides a collision; that is a
 * duplicate the desk has to fix, and picking one is better than admitting nobody.
 *
 * A read that fails throws, as in `resolveIdentity`: an unanswered chain must not be rendered as
 * "no such badge", which would turn an RPC blip into a queue of people told they are not members.
 */
export async function resolveByLabel(
  label: string,
  org: Organization,
): Promise<ResolvedIdentity | null> {
  const branches = await chainBranches(org);
  if (branches.length === 0) {
    throw new Error("no branches could be read; cannot rule out a membership");
  }

  const found = await Promise.all(
    branches.map((branch) => resolveIdentity(`${label}.${branch.name}`)),
  );
  return found.find((identity) => identity !== null) ?? null;
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

const chainBranchCache = new Map<Address, { at: number; branches: ChainBranch[] }>();

export async function chainBranches(org: Organization): Promise<ChainBranch[]> {
  const where = {
    factory: org.branchFactory,
    orgRegistry: org.registry,
    orgResolver: org.resolver,
    organization: org.name,
  };

  // Cached: this is reached from an unauthenticated endpoint, and the scan is O(blocks) with no
  // upper bound. Branches are created a handful of times in an organization's life.
  // Keyed by factory: two organizations must not share a cached branch list.
  const cached = chainBranchCache.get(where.factory);
  if (cached && Date.now() - cached.at < 30_000) return cached.branches;

  // The factory keeps the list; no log scan, and no growing block range to be refused.
  const labels = (await client.readContract({
    address: where.factory,
    abi: branchFactoryAbi,
    functionName: "allBranchLabels",
  })) as string[];

  const byLabel = new Map<string, { registrar: Address; registry: Address }>();
  await Promise.all(
    labels.map(async (label) => {
      const registry = (await client.readContract({
        address: where.orgRegistry,
        abi: registryAbi,
        functionName: "getSubregistry",
        args: [label],
      })) as Address;
      if (registry === ZERO_ADDRESS) return;

      // The registrar is published as a text record precisely so it is discoverable.
      const published = (await client.readContract({
        address: where.orgResolver,
        abi: resolverAbi,
        functionName: "text",
        args: [namehash(`${label}.${where.organization}`), "ensca.registrar"],
      })) as string;
      if (!/^0x[0-9a-fA-F]{40}$/.test(published)) return;

      byLabel.set(label, { registrar: published as Address, registry });
    }),
  );
  const branches = [...byLabel]
    .map(([label, { registrar, registry }]) => ({
      name: `${label}.${where.organization}`,
      label,
      registrar,
      registry,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  chainBranchCache.set(where.factory, { at: Date.now(), branches });
  return branches;
}
