import { NextRequest, NextResponse } from "next/server";
import { branchLabelAvailable, createBranch, signerConfigured } from "@/lib/ens/write";
import type { Address } from "viem";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** `?label=tokyo` → is that branch label free under the organization? */
export async function GET(req: NextRequest) {
  const label = (req.nextUrl.searchParams.get("label") ?? "").trim().toLowerCase();
  if (!/^[a-z0-9-]{1,32}$/.test(label)) {
    return NextResponse.json({ label, valid: false, available: false });
  }
  try {
    return NextResponse.json({ label, valid: true, available: await branchLabelAvailable(label) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "lookup failed" },
      { status: 502 },
    );
  }
}

/** Open a branch — registry, registrar, pointers and discovery record, in one transaction. */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    label?: string;
    expiry?: number;
    owner?: string;
  };

  if (!body.label) return NextResponse.json({ error: "label required" }, { status: 400 });
  if (!signerConfigured()) {
    return NextResponse.json({ error: "ORG_PRIVATE_KEY not set" }, { status: 503 });
  }

  // Default to a year out, which is the organization name's own horizon.
  const expiry = body.expiry ?? Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;

  try {
    const result = await createBranch({
      label: body.label.trim().toLowerCase(),
      expiry,
      owner: body.owner as Address | undefined,
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "transaction failed" },
      { status: 502 },
    );
  }
}
