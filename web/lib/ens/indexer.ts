import "server-only";
import { ENTITLEMENT_KEYS } from "./config";

/**
 * The ENS staging indexer for ENSv2.
 *
 * The whole organization is discoverable from ENS alone, with no hardcoded branch list:
 *
 *   - a **Branch** is a name under the organization that has a *subregistry*; a Member name is one
 *     that does not. That distinction is the domain model, and the index exposes it directly.
 *   - a branch publishes its **registrar** as an `ensca.registrar` text record, because a registrar
 *     is only an EAC role holder and is otherwise invisible to any indexer.
 *
 * So adding a branch requires no redeploy and no config change here — it appears as soon as it is
 * registered and its registrar record is written.
 */

export const INDEXER_URL = process.env.ENS_INDEXER_URL ?? "https://staging-graphql.ens.dev";

type Resolved = Record<string, string | null> | null;

type IndexedDomain = {
  name: string;
  owner: { id: string } | null;
  subregistry: { address: string; labelCount: number } | null;
  resolver: Resolved;
};

export type IndexedBranch = {
  label: string;
  name: string;
  registry: string;
  registrar: string | null;
  memberCount: number;
};

export type IndexedMembership = {
  branch: string;
  branchLabel: string;
  label: string;
  name: string;
  owner: string;
  entitlements: Record<string, string>;
};

const TEXT_SELECTION = ENTITLEMENT_KEYS.map(
  (key, i) => `k${i}: text(key: ${JSON.stringify(key)})`,
).join(" ");

async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch(INDEXER_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(variables ? { query, variables } : { query }),
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`indexer ${res.status}`);

  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length) throw new Error(body.errors[0].message);
  if (!body.data) throw new Error("indexer returned no data");
  return body.data;
}

function entitlementsFrom(resolver: Resolved): Record<string, string> {
  const out: Record<string, string> = {};
  ENTITLEMENT_KEYS.forEach((key, i) => {
    const value = resolver?.[`k${i}`];
    if (value) out[key] = value;
  });
  return out;
}

/**
 * Every name under the organization, in one query.
 *
 * One request covers the whole tree — branches and their memberships — rather than one per branch,
 * which is what keeps this cheap as an organization grows.
 */
async function orgTree(organization: string): Promise<IndexedDomain[]> {
  const data = await gql<{ domains: IndexedDomain[] }>(`{
    domains(where: { name_ends_with: ${JSON.stringify(`.${organization}`)} }) {
      name
      owner { id }
      subregistry { address labelCount }
      resolver { registrar: text(key: "ensca.registrar") ${TEXT_SELECTION} }
    }
  }`);
  return data.domains;
}

/** Branches: names under the organization that carry a registry of their own. */
export async function getIndexedBranches(organization: string): Promise<IndexedBranch[]> {
  const suffix = `.${organization}`;
  return orgTree(organization)
    .then((domains) =>
      domains
        .filter((d) => d.subregistry !== null)
        .map((d) => ({
          label: d.name.slice(0, -suffix.length),
          name: d.name,
          registry: d.subregistry!.address,
          registrar: d.resolver?.registrar ?? null,
          memberCount: d.subregistry!.labelCount,
        }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    );
}

/**
 * Memberships across every branch, or one branch if `branchLabel` is given.
 *
 * A membership is a name two levels below the organization; a Member name is one level below. The
 * depth is what tells them apart, so no per-branch query is needed.
 */
export async function getIndexedMemberships(
  organization: string,
  branchLabel?: string,
): Promise<IndexedMembership[]> {
  const domains = await orgTree(organization);
  const branchLabels = new Set(
    domains.filter((d) => d.subregistry !== null).map((d) => d.name.split(".")[0]),
  );

  const rows: IndexedMembership[] = [];
  for (const d of domains) {
    if (!d.owner || d.subregistry) continue;

    const parts = d.name.split(".");
    // <member>.<branch>.<org> — an org-level Member name is one part shorter. Derived from the
    // organization's own depth rather than assuming it is two labels.
    if (parts.length !== organization.split(".").length + 2) continue;

    const [label, branch] = parts;
    if (!branchLabels.has(branch)) continue;
    if (branchLabel && branch !== branchLabel) continue;

    rows.push({
      branch: `${branch}.${organization}`,
      branchLabel: branch,
      label,
      name: d.name,
      owner: d.owner.id,
      entitlements: entitlementsFrom(d.resolver),
    });
  }
  return rows;
}

export async function getIndexerStatus(): Promise<{ block: number } | null> {
  try {
    const data = await gql<{ _meta: { block: { number: number } } }>(
      `{ _meta { block { number } } }`,
    );
    return { block: data._meta.block.number };
  } catch {
    return null;
  }
}

export type OwnedName = {
  name: string;
  label: string;
  expiry: number | null;
  /** A two-label `.eth` name can be an organization root; a deeper one is already somebody's subname. */
  isTopLevel: boolean;
};

/**
 * Every name this wallet holds.
 *
 * Convenience, not authority. The indexer runs behind the chain, so a name registered a minute
 * ago will not be here yet — which is exactly when somebody comes back from the ENS app looking
 * for it. The search box resolves ownership directly against the registry for that reason, and
 * this list is the shortcut for names that have been around a while.
 */
export async function namesOwnedBy(owner: string): Promise<OwnedName[]> {
  const data = await gql<{
    domains: { name: string; expiryDate: string | null }[];
  }>(
    `query Owned($owner: String!) {
       domains(where: { owner: $owner }, first: 200, orderBy: name) {
         name
         expiryDate
       }
     }`,
    { owner: owner.toLowerCase() },
  );

  const now = Math.floor(Date.now() / 1000);
  return (data.domains ?? [])
    .map((d) => {
      const parts = d.name.split(".");
      const expiry = d.expiryDate ? Number(d.expiryDate) : null;
      return {
        name: d.name,
        label: parts[0] ?? d.name,
        expiry,
        isTopLevel: parts.length === 2 && parts[1] === "eth",
      };
    })
    // An expired name is not one you can build on, and showing it invites a confusing failure.
    .filter((d) => d.expiry === null || d.expiry > now)
    .sort((a, b) => a.name.localeCompare(b.name));
}
