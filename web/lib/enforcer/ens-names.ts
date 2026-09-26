import "server-only";
import { call, mirrorConfigured } from "./mirror";

/**
 * The local record of every ENS name this console has written.
 *
 * Deliberately not a cache of memberships. Nothing on chain enumerates the members of a branch,
 * so when the indexer falls behind there is no list to read — but the console does know which
 * names it wrote, and a name is enough to go and ask the chain about. This module stores and
 * retrieves those names; `getMemberships` is what turns them into an answer, and it does so by
 * verifying each one against the registry. A row here is a question, never a fact.
 *
 * It lives in the enforcer's SQLite because that is the only durable store this deployment has,
 * and it is reached over the enforcer's admin API with the enforcer's token — never as a local
 * file, because in production the enforcer is on the branch VM and the web app is not.
 */

export type EnsNameKind = "organization" | "branch" | "membership";

export type EnsCandidate = {
  name: string;
  kind: EnsNameKind;
  org: string;
  branch_label: string | null;
  label: string;
  owner: string | null;
  registrar: string | null;
  tx_hash: string | null;
  created_at: number;
};

/**
 * Remember a name the console has just written.
 *
 * Never throws: this runs after a transaction has already landed, and a bookkeeping failure must
 * not be reported as a failed write. The cost of losing a row is that this one name cannot be
 * verified during an indexer outage, which is where the console was before this existed.
 */
export async function recordEnsName(input: {
  name: string;
  kind: EnsNameKind;
  owner?: string | null;
  registrar?: string | null;
  txHash?: string | null;
}): Promise<boolean> {
  if (!mirrorConfigured()) return false;
  try {
    const res = await call("POST", "/admin/ens-names", {
      name: input.name.trim().toLowerCase(),
      kind: input.kind,
      owner: input.owner ?? undefined,
      registrar: input.registrar ?? undefined,
      tx_hash: input.txHash ?? undefined,
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

/**
 * The names worth asking the chain about for this organization.
 *
 * An enforcer that is unconfigured or unreachable yields no candidates rather than an error: the
 * caller then has nothing the chain confirmed, and must go on reporting the index as stale
 * instead of presenting an empty list as an answer.
 *
 * `branchLabel` is passed to the enforcer rather than filtered here, so a caller asking about
 * one branch cannot be handed another branch's candidates.
 */
export async function listEnsCandidates(
  org: string,
  kind: EnsNameKind,
  branchLabel?: string,
): Promise<EnsCandidate[]> {
  if (!mirrorConfigured()) return [];
  const params = new URLSearchParams({ org, kind });
  if (branchLabel) params.set("branch", branchLabel);
  try {
    const res = await call("GET", `/admin/ens-names?${params}`);
    if (res.status !== 200) return [];
    const names = res.json.names as EnsCandidate[] | undefined;
    return Array.isArray(names) ? names : [];
  } catch {
    return [];
  }
}
