import { NextRequest, NextResponse } from "next/server";
import { enforcerGroupName, mirrorMember } from "@/lib/enforcer/mirror";
import { getRoles } from "@/lib/ens/read";
import { onboardMember, signerConfigured } from "@/lib/ens/write";
import type { Address } from "viem";
import { branchForRegistrar } from "@/lib/ens/registrars";

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
  // The same charset the contract enforces. A label containing a dot mints a name that
  // `resolveIdentity` can never parse, permanently denying that member at the portal.
  if (!/^[a-z0-9-]{1,32}$/.test(body.label.trim().toLowerCase())) {
    return NextResponse.json({ error: "invalid label" }, { status: 400 });
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

  const label = body.label.trim().toLowerCase();
  // `defineRole` stored the role lowercased, and `roleId` is keccak of the exact string — so a
  // differently-cased group here either reverts or assigns a role that does not exist.
  const group = body.group.trim().toLowerCase();

  try {
    const txHash = await onboardMember({
      branchRegistrar: body.registrar as Address,
      label,
      owner: body.owner as Address,
      group,
      memberLabel: body.memberLabel?.trim().toLowerCase() || undefined,
    });

    // The name is minted. Now tell the enforcer, or the member resolves to no local user and
    // shares the `portal-anon` quota bucket with everyone else in the same position.
    // Derived from the registrar, not accepted from the body. A claimed branch name let an
    // onboarding into one branch PATCH a member of another, repointing their group.
    const branch = branchOf.name;
    let mirror: { mirrored: boolean; reason?: string } = {
      mirrored: false,
      reason: "not attempted",
    };
    {
      // Everything past this point is best-effort: the membership is already minted, and this
      // whole block throwing would report a landed transaction as a failure. The operator would
      // retry and hit a revert on a name that now exists.
      try {
        // The enforcer looks a member's group up by their `wifi.group` entitlement, which is a
        // property of the role, not its name. Read it back rather than assuming they match.
        const roles = await getRoles(body.registrar as Address);
        const role = roles.find((r) => r.name === group);
        mirror = await mirrorMember({
          ensName: `${label}.${branch}`,
          wallet: body.owner!,
          group: enforcerGroupName(group, role?.entitlements),
        });
      } catch (error) {
        mirror = {
          mirrored: false,
          reason: error instanceof Error ? error.message : "could not reach the enforcer",
        };
      }
    }

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
