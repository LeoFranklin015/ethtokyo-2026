import { NextRequest, NextResponse } from "next/server";
import { getRoles } from "@/lib/ens/read";
import type { Address } from "viem";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** The groups a branch defines. `?registrar=0x…` selects the branch. */
export async function GET(req: NextRequest) {
  // No default. `getRoles()` falls back to a hardcoded registrar, so a missing parameter used
  // to return a different branch's catalogue with HTTP 200.
  const registrar = req.nextUrl.searchParams.get("registrar");
  if (!registrar || !/^0x[0-9a-fA-F]{40}$/.test(registrar)) {
    return NextResponse.json({ error: "registrar required" }, { status: 400 });
  }
  try {
    const groups = await getRoles(registrar as Address);
    return NextResponse.json({ groups });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "read failed" },
      { status: 502 },
    );
  }
}

/** Create or redefine a group — a category of people, not a name. */

/**
 * No POST. Defining a group is `defineRole` on a branch registrar, which checks
 * `ROLE_ROLE_EDIT` on its caller — so it is signed by the branch owner's wallet in
 * `lib/ens/useEnsWrites.ts`, and mirrored into the enforcer by `/api/ens/mirror`, which
 * re-reads the chain rather than believing the client.
 */
