import { NextRequest, NextResponse } from "next/server";
import { branchLabelAvailable } from "@/lib/ens/availability";
import { orgFromRequest } from "@/lib/ens/route-org";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** `?label=tokyo` → is that branch label free under the organization? */
export async function GET(req: NextRequest) {
  const { org, error } = await orgFromRequest(req.nextUrl);
  if (error) return error;

  const label = (req.nextUrl.searchParams.get("label") ?? "").trim().toLowerCase();
  if (!/^[a-z0-9-]{1,32}$/.test(label)) {
    return NextResponse.json({ label, valid: false, available: false });
  }
  try {
    return NextResponse.json({ label, valid: true, available: await branchLabelAvailable(org.branchFactory, label) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "lookup failed" },
      { status: 502 },
    );
  }
}

/** Open a branch — registry, registrar, pointers and discovery record, in one transaction. */

/**
 * There is no POST here any more.
 *
 * Opening a branch used to be a server operation signed by `ORG_PRIVATE_KEY`. The factory
 * already checks `ROLE_CREATE_BRANCH` on the caller, so a server key holding that role replaced
 * a per-actor on-chain check with "did the request reach our server" — weaker, and it made the
 * web host custodian of the organization. `lib/ens/useEnsWrites.ts` signs it from the owner's
 * wallet instead.
 */
