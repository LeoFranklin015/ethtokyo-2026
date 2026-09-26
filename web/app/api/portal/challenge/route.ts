import { NextRequest, NextResponse } from "next/server";
import { challengeMessage, issueNonce } from "@/lib/portal/nonces";

export const dynamic = "force-dynamic";

/**
 * Hand the device a one-time nonce to sign.
 *
 * Deliberately open: the person asking has not proved anything yet, and cannot — that is what
 * the next call is for. The nonce is single-use and short-lived, so issuing one costs nothing.
 *
 * This exists because the live portal admits anyone who types a name into a box. An ENS name is
 * public, so without a signature it is a bearer token: typing `alice.eth` admits you as Alice.
 *
 * The text to sign is composed here and returned with the nonce. When the page built it too, any
 * divergence in wording produced a signature over a message the server never saw, and the only
 * symptom was a flat refusal with nothing to point at.
 */
export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  const { nonce, expiresInSeconds } = issueNonce(ip);
  return NextResponse.json({ nonce, expiresInSeconds, message: challengeMessage(nonce) });
}

/**
 * The guest's address, and only when something is entitled to say what it is.
 *
 * `x-forwarded-for` is a request header: any client can set it. The address it carries is not
 * merely used to scope a nonce — `verify` hands it to `admit()`, which opens a firewall rule for
 * it. Honoured unconditionally, that let an already-admitted member sign with their own valid
 * membership while claiming somebody else's address, and put an unlimited number of devices on
 * the network from one badge. That is precisely what this product exists to prevent.
 *
 * So the header counts only from the branch portal, which proves itself with a shared secret.
 * Everything else is treated as having no address at all, which fails closed: `admit()` refuses
 * `"unknown"` outright rather than guessing.
 *
 * With `PORTAL_RELAY_TOKEN` unset the header is never honoured. That is deliberate — a missing
 * secret must not mean "trust everyone", which is how this was open to begin with.
 */
export function clientIp(req: NextRequest): string {
  const expected = process.env.PORTAL_RELAY_TOKEN;
  const presented = req.headers.get("x-portal-token");
  const fromPortal =
    Boolean(expected) && presented !== null && presented.length === expected!.length && presented === expected;

  if (!fromPortal) return "unknown";

  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}
