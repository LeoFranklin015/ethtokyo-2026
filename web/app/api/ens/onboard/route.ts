import { NextRequest, NextResponse } from "next/server";
import { onboardMember, signerConfigured } from "@/lib/ens/write";
import type { Address } from "viem";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Mint a membership and assign its group, in one transaction. */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    registrar?: string;
    label?: string;
    owner?: string;
    group?: string;
    memberLabel?: string;
  };

  if (!body.registrar || !body.label || !body.owner || !body.group) {
    return NextResponse.json(
      { error: "registrar, label, owner and group are required" },
      { status: 400 },
    );
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(body.owner)) {
    return NextResponse.json({ error: "owner must be a wallet address" }, { status: 400 });
  }
  if (!signerConfigured()) {
    return NextResponse.json({ error: "ORG_PRIVATE_KEY not set" }, { status: 503 });
  }

  try {
    const txHash = await onboardMember({
      branchRegistrar: body.registrar as Address,
      label: body.label.trim().toLowerCase(),
      owner: body.owner as Address,
      group: body.group,
      memberLabel: body.memberLabel?.trim().toLowerCase() || undefined,
    });
    return NextResponse.json({ txHash, label: body.label });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "transaction failed" },
      { status: 502 },
    );
  }
}
