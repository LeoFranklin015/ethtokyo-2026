import { NextResponse } from "next/server";
import { getMemberships } from "@/lib/ens/read";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const memberships = await getMemberships();
    return NextResponse.json({ memberships, total: memberships.length });
  } catch (error) {
    // A chain read failing is reported, never substituted with a plausible number.
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "chain read failed" },
      { status: 502 },
    );
  }
}
