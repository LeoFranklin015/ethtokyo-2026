import { NextRequest, NextResponse } from "next/server";
import { resolveByLabel } from "@/lib/ens/read";
import { resolveOrg } from "@/lib/ens/org";
import { MEMBER_ID_PATTERN } from "@/lib/ens/memberId";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Which membership does this badge belong to, and whose wallet holds it?
 *
 * The captive page needs this before it asks anyone to sign, so that a guest holding the wrong
 * wallet is told which one the badge expects instead of signing a challenge that the admission
 * path would then refuse for reasons they cannot see.
 *
 * Nothing here is a secret: the owner of an ENS name is public on-chain, and the badge is
 * printed on the lanyard. It proves nothing on its own — the proof is still the signature that
 * `verify` checks, and `verify` re-reads the owner rather than trusting what this route said.
 *
 * The status codes carry the distinction the page turns into copy: 404 is a definite "no such
 * badge", 502 is "the chain did not answer", and those must never read the same.
 */
export async function GET(req: NextRequest) {
  const id = (req.nextUrl.searchParams.get("id") ?? "").trim().toLowerCase();
  if (!MEMBER_ID_PATTERN.test(id)) {
    return NextResponse.json({ error: "that is not a badge id" }, { status: 400 });
  }

  const orgLabel = process.env.BRANCH_ORG?.trim();
  if (!orgLabel) {
    return NextResponse.json(
      { error: "this portal has no organization configured" },
      { status: 503 },
    );
  }

  try {
    const org = await resolveOrg(orgLabel);
    if (!org) {
      return NextResponse.json(
        { error: `no organization is set up for ${orgLabel}.eth` },
        { status: 503 },
      );
    }
    const identity = await resolveByLabel(id, org);
    if (!identity) {
      return NextResponse.json({ error: "no membership carries that badge" }, { status: 404 });
    }
    return NextResponse.json({
      id,
      name: identity.name,
      // The member's own name, as the resolver publishes it. Absent for anyone onboarded before
      // it was written, so the page shows the badge id when it is missing rather than a blank.
      displayName: identity.displayName,
      wallet: identity.owner.toLowerCase(),
      branch: identity.branch,
      role: identity.role,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "could not reach the chain" },
      { status: 502 },
    );
  }
}
