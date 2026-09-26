import { NextRequest, NextResponse } from "next/server";
import { getMemberships, indexerLag } from "@/lib/ens/read";
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
    // Memberships can only come from the index — nothing on chain enumerates the members of a
    // branch — so the caller has to be told how old that index is. An empty list from an
    // indexer stopped an hour ago is not evidence that a membership does not exist, and the
    // console was using it as exactly that: real members were being labelled "not on chain".
    const lag = await indexerLag(indexer?.block ?? null);
    return NextResponse.json({
      memberships,
      total: memberships.length,
      source,
      indexedBlock: indexer?.block ?? null,
      lag,
      // Generous: a handful of blocks is ordinary indexing delay, not staleness.
      stale: lag === null ? true : lag > 30,
    });
  } catch (error) {
    // A read failing is reported, never substituted with a plausible number.
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "read failed" },
      { status: 502 },
    );
  }
}
