import { NextRequest, NextResponse } from "next/server";
import { commitOrg, registerOrg, signerAddress, signerConfigured } from "@/lib/ens/write";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Who the console signs as, and whether it can sign at all. */
export async function GET() {
  return NextResponse.json({ configured: signerConfigured(), signer: signerAddress() });
}

/**
 * `{ step: "commit", label }`   → approve payment and publish the commitment
 * `{ step: "register", label }` → reveal it once MIN_COMMITMENT_AGE has passed
 */
export async function POST(req: NextRequest) {
  const { step, label, owner } = (await req.json().catch(() => ({}))) as {
    step?: string;
    label?: string;
    owner?: string;
  };

  if (!label) return NextResponse.json({ error: "label required" }, { status: 400 });
  if (!/^[a-z0-9-]{1,32}$/.test(label)) {
    return NextResponse.json({ error: "invalid label" }, { status: 400 });
  }
  // The connected wallet owns the org name. Without it the server key would own it instead,
  // which is the whole thing this flow exists to avoid.
  if (!owner || !/^0x[0-9a-fA-F]{40}$/.test(owner)) {
    return NextResponse.json({ error: "connect a wallet first" }, { status: 400 });
  }
  if (!signerConfigured()) {
    return NextResponse.json({ error: "ORG_PRIVATE_KEY not set" }, { status: 503 });
  }

  try {
    if (step === "commit") return NextResponse.json(await commitOrg(label, owner as `0x${string}`));
    if (step === "register")
      return NextResponse.json(await registerOrg(label, owner as `0x${string}`));
    return NextResponse.json({ error: "step must be commit or register" }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "transaction failed" },
      { status: 502 },
    );
  }
}
