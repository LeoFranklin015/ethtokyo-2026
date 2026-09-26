import { NextRequest, NextResponse } from "next/server";
import { checkAvailability, labelAvailable } from "@/lib/ens/write";
import type { Address } from "viem";

export const dynamic = "force-dynamic";

const LABEL = /^[a-z0-9-]{1,32}$/;

/**
 * `?label=acme`                        → is `acme.eth` free, and what does a year cost?
 * `?label=leo&registry=0x…`            → is `leo` free inside that branch registry?
 */
export async function GET(req: NextRequest) {
  const label = (req.nextUrl.searchParams.get("label") ?? "").trim().toLowerCase();
  const registry = req.nextUrl.searchParams.get("registry");

  if (!LABEL.test(label)) {
    return NextResponse.json(
      { label, valid: false, reason: "lowercase letters, digits and hyphens only, 1–32 chars" },
      { status: 200 },
    );
  }

  try {
    if (registry) {
      const available = await labelAvailable(registry as Address, label);
      return NextResponse.json({ label, valid: true, available });
    }
    return NextResponse.json({ valid: true, ...(await checkAvailability(label)) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "lookup failed" },
      { status: 502 },
    );
  }
}
