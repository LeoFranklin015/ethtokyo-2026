import { NextRequest, NextResponse } from "next/server";
import { getMemberships } from "@/lib/ens/read";
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
