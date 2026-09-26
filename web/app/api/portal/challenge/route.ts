import { NextRequest, NextResponse } from "next/server";
import { issueNonce } from "@/lib/portal/nonces";

export const dynamic = "force-dynamic";

/**
 * Hand the device a one-time nonce to sign.
 *
 * Deliberately open: the person asking has not proved anything yet, and cannot — that is what
 * the next call is for. The nonce is single-use and short-lived, so issuing one costs nothing.
 *
 * This exists because the live portal admits anyone who types a name into a box. An ENS name is
 * public, so without a signature it is a bearer token: typing `alice.eth` admits you as Alice.
 */
export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  const { nonce, expiresInSeconds } = issueNonce(ip);
  return NextResponse.json({ nonce, expiresInSeconds });
}

export function clientIp(req: NextRequest): string {
  // On the branch LAN the console sits behind nothing, so the connection address is the device.
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}
