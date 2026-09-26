import { NextRequest, NextResponse } from "next/server";
import { getMemberships, indexerLag, STALE_AFTER_BLOCKS } from "@/lib/ens/read";
import { orgFromRequest } from "@/lib/ens/route-org";
import { getIndexerStatus } from "@/lib/ens/indexer";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { org, error } = await orgFromRequest(req.nextUrl);
  if (error) return error;

  // ?branch=<label> scopes to one branch; omitted, every branch in the organization.
  const branch = req.nextUrl.searchParams.get("branch") ?? undefined;
  try {
    const [{ memberships, source }, indexer] = await Promise.all([
      getMemberships(org.name, branch ?? undefined, org.orgRegistrar),
      getIndexerStatus(),
    ]);
    // The caller has to be told how old the index is: an empty list from an indexer stopped an
    // hour ago is not evidence that a membership does not exist, and the console was using it as
    // exactly that — real members were being labelled "not on chain". `source` says which path
    // actually produced these rows, and `source: "chain"` means each was read back off the
    // registry in this request, so it is an answer whatever the lag says.
    const lag = await indexerLag(indexer?.block ?? null);
    return NextResponse.json({
      memberships,
      total: memberships.length,
      source,
      indexedBlock: indexer?.block ?? null,
      lag,
      // Generous: a handful of blocks is ordinary indexing delay, not staleness. The same
      // threshold `getMemberships` uses to decide whether to verify candidates on chain, so the
      // two cannot disagree about whether the index is worth believing.
      stale: lag === null ? true : lag > STALE_AFTER_BLOCKS,
    });
  } catch (error) {
    // A read failing is reported, never substituted with a plausible number.
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "read failed" },
      { status: 502 },
    );
  }
}
