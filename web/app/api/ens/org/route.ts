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
  const { step, label } = (await req.json().catch(() => ({}))) as {
    step?: string;
    label?: string;
  };

  if (!label) return NextResponse.json({ error: "label required" }, { status: 400 });
  if (!signerConfigured()) {
    return NextResponse.json({ error: "ORG_PRIVATE_KEY not set" }, { status: 503 });
  }

  try {
    if (step === "commit") return NextResponse.json(await commitOrg(label));
    if (step === "register") return NextResponse.json(await registerOrg(label));
    return NextResponse.json({ error: "step must be commit or register" }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "transaction failed" },
      { status: 502 },
    );
  }
}
