import { NextRequest, NextResponse } from "next/server";
import { mirrorMember } from "@/lib/enforcer/mirror";
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
    branch?: string;
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

  const label = body.label.trim().toLowerCase();

  try {
    const txHash = await onboardMember({
      branchRegistrar: body.registrar as Address,
      label,
      owner: body.owner as Address,
      group: body.group,
      memberLabel: body.memberLabel?.trim().toLowerCase() || undefined,
    });

    // The name is minted. Now tell the enforcer, or the member resolves to no local user and
    // shares the `portal-anon` quota bucket with everyone else in the same position.
    const branch = body.branch?.trim().toLowerCase();
    const mirror = branch
      ? await mirrorMember({
          ensName: `${label}.${branch}`,
          wallet: body.owner,
          group: body.group,
        })
      : { mirrored: false, reason: "branch name not supplied" };

    // A failed mirror does not fail the request: the transaction already landed and ENS is the
    // authority. The caller is told so it can say so.
    return NextResponse.json({ txHash, label, ...mirror });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "transaction failed" },
      { status: 502 },
    );
  }
}
