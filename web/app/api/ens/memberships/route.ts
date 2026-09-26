import { NextResponse } from "next/server";
import { getMemberships } from "@/lib/ens/read";
import { getIndexerStatus } from "@/lib/ens/indexer";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [{ memberships, source }, indexer] = await Promise.all([
      getMemberships(),
      getIndexerStatus(),
    ]);
    return NextResponse.json({
      memberships,
      total: memberships.length,
      source,
      indexedBlock: indexer?.block ?? null,
    });
  } catch (error) {
    // A read failing is reported, never substituted with a plausible number.
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "read failed" },
      { status: 502 },
    );
  }
}
