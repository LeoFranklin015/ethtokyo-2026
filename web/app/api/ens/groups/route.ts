import { NextRequest, NextResponse } from "next/server";
import { defineGroup, signerConfigured } from "@/lib/ens/write";
import { getRoles } from "@/lib/ens/read";
import type { Address } from "viem";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** The groups a branch defines. `?registrar=0x…` selects the branch. */
export async function GET(req: NextRequest) {
  const registrar = req.nextUrl.searchParams.get("registrar");
  try {
    const groups = await getRoles(registrar ? (registrar as Address) : undefined);
    return NextResponse.json({ groups });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "read failed" },
      { status: 502 },
    );
  }
}

/** Create or redefine a group — a category of people, not a name. */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    registrar?: string;
    name?: string;
    canOnboard?: boolean;
    openToOnboarders?: boolean;
    editableKeys?: string[];
    entitlements?: { key: string; value: string }[];
  };

  if (!body.registrar || !body.name) {
    return NextResponse.json({ error: "registrar and name required" }, { status: 400 });
  }
  if (!signerConfigured()) {
    return NextResponse.json({ error: "ORG_PRIVATE_KEY not set" }, { status: 503 });
  }

  try {
    const txHash = await defineGroup({
      branchRegistrar: body.registrar as Address,
      name: body.name.trim().toLowerCase(),
      canOnboard: body.canOnboard ?? false,
      openToOnboarders: body.openToOnboarders ?? true,
      editableKeys: body.editableKeys ?? [],
      entitlements: (body.entitlements ?? []).filter((e) => e.key && e.value),
    });
    return NextResponse.json({ txHash, name: body.name });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "transaction failed" },
      { status: 502 },
    );
  }
}
