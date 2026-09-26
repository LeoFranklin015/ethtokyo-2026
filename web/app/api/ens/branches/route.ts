import { NextRequest, NextResponse } from "next/server";
import { getIndexedBranches, getIndexerStatus } from "@/lib/ens/indexer";
import { chainBranches } from "@/lib/ens/read";
import { orgFromRequest } from "@/lib/ens/route-org";

export const dynamic = "force-dynamic";

/**
 * Every branch this organization has opened.
 *
 * Two sources, merged, because they fail in opposite directions. The indexer answers in one
 * query and carries member counts, but runs minutes behind the chain — so a branch opened a
 * moment ago is missing from it. The factory's `BranchCreated` logs are visible in the block
 * the branch was created in, but carry nothing else.
 *
 * This used to be indexer-only, which meant an operator who had just opened a branch could not
 * see it, could not define a group on it, and could not onboard anyone into it — for as long as
 * the indexer took to catch up. Every console screen that picks a branch reads this route.
 */
export async function GET(req: NextRequest) {
  const { org, error } = await orgFromRequest(req.nextUrl);
  if (error) return error;

  const [indexed, fromChain, indexer] = await Promise.all([
    getIndexedBranches(org.name).catch((e: unknown) => e as Error),
    chainBranches(org).catch((e: unknown) => e as Error),
    getIndexerStatus().catch(() => null),
  ]);

  const indexedOk = !(indexed instanceof Error);
  const chainOk = !(fromChain instanceof Error);

  // Both sources gone means we genuinely do not know. Say so rather than answering "none",
  // which a caller cannot tell from an organization with no branches.
  if (!indexedOk && !chainOk) {
    return NextResponse.json(
      { error: (indexed as Error).message || "no branch source could be read" },
      { status: 502 },
    );
  }

  const merged = new Map<string, Record<string, unknown>>();
  if (chainOk) {
    for (const b of fromChain) {
      merged.set(b.label, { ...b, memberCount: null, source: "chain" });
    }
  }
  if (indexedOk) {
    // The indexer's row wins where it exists: same identity, more detail.
    for (const b of indexed) merged.set(b.label, { ...b, source: "indexer" });
  }

  return NextResponse.json({
    branches: [...merged.values()].sort((a, b) =>
      String(a.label).localeCompare(String(b.label)),
    ),
    indexedBlock: indexer?.block ?? null,
    // So the console can say "this branch is too new to be indexed" rather than showing a row
    // with blanks and leaving the operator to guess.
    organization: org.name,
    indexerAvailable: indexedOk,
  });
}
