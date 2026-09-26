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

  // The chain decides which branches exist; the indexer only enriches them.
  //
  // It used to be the other way round — the indexer's row won wherever it had one — and that is
  // how a branch from a registry the organization no longer points at stayed on screen. Setting
  // a name up a second time deploys a fresh registry, and an indexer that has not caught up
  // still lists the old one's children. `sairann.eth` showed `tokyo` from a superseded registry
  // while the factory's own list said `tokyoo, bggg`: a branch that could be picked, and that
  // nothing would resolve through.
  //
  // `allBranchLabels()` is the factory's own list, so the chain answer is complete rather than a
  // best effort — there is no reason to let a stale row outvote it.
  const merged = new Map<string, Record<string, unknown>>();
  if (chainOk) {
    const enrichment = new Map(indexedOk ? indexed.map((b) => [b.label, b]) : []);
    for (const b of fromChain) {
      const extra = enrichment.get(b.label);
      merged.set(b.label, {
        ...b,
        // Only the indexer counts members, so without it that figure is unknown, not zero.
        memberCount: extra?.memberCount ?? null,
        registrar: b.registrar ?? extra?.registrar ?? null,
        source: extra ? "indexer" : "chain",
      });
    }
  } else if (indexedOk) {
    // The chain could not be read. The indexer is all there is, and it may be behind — so the
    // caller is told the list came from it alone rather than being handed it as settled fact.
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
