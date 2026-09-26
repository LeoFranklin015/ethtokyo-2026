import "server-only";
import { ENS, ENTITLEMENT_KEYS } from "./config";

/**
 * The ENS staging indexer for ENSv2.
 *
 * It indexes our user-deployed branch registry, which the self-hosted route could not be relied on
 * to do — memberships, owners and resolver text records all come back in a single round trip.
 * That replaces roughly ten contract reads per membership.
 *
 * What it cannot serve is anything defined by *our* contracts: the readable role name (a role id is
 * `keccak256(name)`, recoverable only from our `RoleDefined` event), the EAC bitmap a holder has
 * over their own name, and the Member↔Membership link. Those still come from `read.ts`, so the two
 * are complementary rather than alternatives.
 */

export const INDEXER_URL =
  process.env.ENS_INDEXER_URL ?? "https://staging-graphql.ens.dev";

type IndexedDomain = {
  name: string;
  owner: { id: string } | null;
  resolver: Record<string, string | null> | null;
};

export type IndexedMembership = {
  label: string;
  name: string;
  owner: string;
  entitlements: Record<string, string>;
};

/** GraphQL aliases, so every entitlement key arrives in the one query. */
const TEXT_SELECTION = ENTITLEMENT_KEYS.map(
  (key, i) => `k${i}: text(key: ${JSON.stringify(key)})`,
).join(" ");

async function gql<T>(query: string): Promise<T> {
  const res = await fetch(INDEXER_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`indexer ${res.status}`);

  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length) throw new Error(body.errors[0].message);
  if (!body.data) throw new Error("indexer returned no data");
  return body.data;
}

/** Every membership in the branch, with its entitlements, in one request. */
export async function getIndexedMemberships(): Promise<IndexedMembership[]> {
  const suffix = `.${ENS.branch}`;
  const data = await gql<{ domains: IndexedDomain[] }>(`{
    domains(where: { name_ends_with: ${JSON.stringify(suffix)} }) {
      name
      owner { id }
      resolver { ${TEXT_SELECTION} }
    }
  }`);

  return data.domains
    .filter((d) => d.name !== ENS.branch && d.owner)
    .map((d) => {
      const entitlements: Record<string, string> = {};
      ENTITLEMENT_KEYS.forEach((key, i) => {
        const value = d.resolver?.[`k${i}`];
        if (value) entitlements[key] = value;
      });
      return {
        label: d.name.slice(0, -suffix.length),
        name: d.name,
        owner: d.owner!.id,
        entitlements,
      };
    });
}

/** Liveness plus how far behind the chain the index is. */
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
