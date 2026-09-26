/**
 * Tell the enforcer about a name this browser has just written to ENS.
 *
 * Through `/api/admin`, because that is the one route that holds the enforcer's token and it is
 * gated by a proven-ownership session — which the console has by the time it is writing names.
 * The record is only a list of names to verify later, so an operator who has proved they own the
 * organization is the right person to be adding to it.
 *
 * Never awaited for its result by the write paths and never throws: the transaction has already
 * landed, and losing a row costs that one name its place in the candidate list, nothing more.
 */
export async function recordEnsName(input: {
  name: string;
  kind: "organization" | "branch";
  owner?: string;
  registrar?: string;
  txHash?: string;
}): Promise<void> {
  try {
    await fetch("/api/admin/ens-names", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: input.name.trim().toLowerCase(),
        kind: input.kind,
        owner: input.owner,
        registrar: input.registrar,
        tx_hash: input.txHash,
      }),
    });
  } catch {
    // An unreachable enforcer is not this flow's problem to report.
  }
}
