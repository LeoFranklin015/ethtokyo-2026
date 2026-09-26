import { NextRequest, NextResponse } from "next/server";
import { enforcerGroupName, mirrorGroup } from "@/lib/enforcer/mirror";
import { defineGroup, signerConfigured } from "@/lib/ens/write";
import { getRoles } from "@/lib/ens/read";
import type { Address } from "viem";
import { branchForRegistrar } from "@/lib/ens/registrars";

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

  // The org key signs this. The target must be one of our own registrars, not any address the
  // caller fancies. A lookup failure is a 502, never a 403 — we cannot prove it is not ours.
  let branchOf;
  try {
    branchOf = await branchForRegistrar(body.registrar);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "could not verify the registrar" },
      { status: 502 },
    );
  }
  if (!branchOf) {
    return NextResponse.json(
      { error: "that registrar does not belong to this organization" },
      { status: 403 },
    );
  }

  const name = body.name.trim().toLowerCase();

  try {
    const txHash = await defineGroup({
      branchRegistrar: body.registrar as Address,
      name,
      canOnboard: body.canOnboard ?? false,
      openToOnboarders: body.openToOnboarders ?? true,
      editableKeys: body.editableKeys ?? [],
      entitlements: (body.entitlements ?? []).filter((e) => e.key && e.value),
    });

    // A group that exists only on chain admits nobody: the enforcer denies any member whose
    // `wifi.group` names a group it has no row for — and it joins on that entitlement, not on
    // the role's name. Lowercased because SQLite compares TEXT case-sensitively, so a row
    // named "Staff" is a row `internal_ens_lookup` will never find.
    const mirror = await mirrorGroup(
      enforcerGroupName(name, body.entitlements).trim().toLowerCase(),
    );
    return NextResponse.json({ txHash, name, ...mirror });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "transaction failed" },
      { status: 502 },
    );
  }
}
