import { NextRequest, NextResponse } from "next/server";
import { resolveByLabel } from "@/lib/ens/read";
import { resolveOrg } from "@/lib/ens/org";
import { MEMBER_ID_PATTERN } from "@/lib/ens/memberId";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const SCRAPER_URL = process.env.SCRAPER_URL ?? "http://127.0.0.1:8090";

async function fetchScraperProfile(
  badgeUrl: string,
): Promise<{ scraperName: string | null; scraperImage: string | null }> {
  try {
    const res = await fetch(
      `${SCRAPER_URL}/scrape?url=${encodeURIComponent(badgeUrl)}`,
      { signal: AbortSignal.timeout(12000) },
    );
    if (!res.ok) return { scraperName: null, scraperImage: null };
    const body = await res.json() as { name?: string; image?: string };
    return { scraperName: body.name ?? null, scraperImage: body.image ?? null };
  } catch {
    return { scraperName: null, scraperImage: null };
  }
}

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

  // Optional: the raw badge URL from the QR scan, used to fetch the ETHGlobal profile.
  const badgeUrl = (req.nextUrl.searchParams.get("url") ?? "").trim();

  try {
    const [org, scraperResult] = await Promise.all([
      resolveOrg(orgLabel),
      badgeUrl ? fetchScraperProfile(badgeUrl) : Promise.resolve({ scraperName: null, scraperImage: null }),
    ]);

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
      displayName: identity.displayName,
      wallet: identity.owner.toLowerCase(),
      branch: identity.branch,
      role: identity.role,
      scraperName: scraperResult.scraperName,
      scraperImage: scraperResult.scraperImage,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "could not reach the chain" },
      { status: 502 },
    );
  }
}
