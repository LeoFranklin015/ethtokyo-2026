import { NextRequest, NextResponse } from "next/server";
import { resolveIdentity } from "@/lib/ens/read";

export const dynamic = "force-dynamic";

/**
 * The enforcer's admission-time lookup.
 *
 * `GET /api/ens/resolve?name=leo.tokyo.acme.eth` → the role and entitlements ENS publishes for
 * that name, or 404 if no live membership holds it. A 404 means deny; a 5xx means the caller
 * should fall back rather than admit.
 */
export async function GET(req: NextRequest) {
  const name = req.nextUrl.searchParams.get("name");
  if (!name) {
    return NextResponse.json({ error: "name required" }, { status: 400 });
  }

  try {
    const identity = await resolveIdentity(name);
    if (!identity) {
      return NextResponse.json({ error: "no_membership", name }, { status: 404 });
    }
    return NextResponse.json(identity);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "resolve failed" },
      { status: 502 },
    );
  }
}
