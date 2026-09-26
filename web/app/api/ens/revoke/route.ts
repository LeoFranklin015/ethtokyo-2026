import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, http, type Address } from "viem";
import { sepolia } from "viem/chains";
import { registrarV2Abi } from "@/lib/ens/abis";
import { RPC_URL } from "@/lib/ens/config";
import { branchForRegistrar } from "@/lib/ens/registrars";
import { revokeMembership, signerConfigured } from "@/lib/ens/write";
import { mirrorRevoke } from "@/lib/enforcer/mirror";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const client = createPublicClient({ chain: sepolia, transport: http(RPC_URL) });

/**
 * End a membership, on chain and on the enforcer.
 *
 * Both halves, in that order, because they protect against different things. The chain write is
 * what makes the name stop resolving, which is what a correctly-working enforcer consults. The
 * enforcer write is what stops them *today*: `internal_ens_lookup` falls back to its local users
 * table whenever the console is unreachable, and without `disabled = 1` that fallback admits a
 * revoked member for the whole duration of an outage.
 *
 * Until this route existed there was no way to revoke anyone through the product at all.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    registrar?: string;
    wallet?: string;
  };

  if (!body.registrar || !body.wallet) {
    return NextResponse.json({ error: "registrar and wallet are required" }, { status: 400 });
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(body.wallet)) {
    return NextResponse.json({ error: "wallet must be an address" }, { status: 400 });
  }
  if (!signerConfigured()) {
    return NextResponse.json({ error: "ORG_PRIVATE_KEY not set" }, { status: 503 });
  }

  let branch;
  try {
    branch = await branchForRegistrar(body.registrar);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "could not verify the registrar" },
      { status: 502 },
    );
  }
  if (!branch) {
    return NextResponse.json(
      { error: "that registrar does not belong to this organization" },
      { status: 403 },
    );
  }

  try {
    const resource = await client.readContract({
      address: body.registrar as Address,
      abi: registrarV2Abi,
      functionName: "membershipOf",
      args: [body.wallet as Address],
    });
    if (resource === 0n) {
      return NextResponse.json({ error: "that wallet holds no membership here" }, { status: 404 });
    }

    // Read the label before the revoke clears it, so the enforcer row can still be found.
    const label = await client.readContract({
      address: body.registrar as Address,
      abi: registrarV2Abi,
      functionName: "labelOf",
      args: [resource],
    });

    const { txHash } = await revokeMembership({
      branchRegistrar: body.registrar as Address,
      resource,
    });

    // Best effort, and reported: the chain write already happened and is the authority.
    let mirror: { mirrored: boolean; reason?: string };
    try {
      mirror = await mirrorRevoke(`${label}.${branch.name}`);
    } catch (error) {
      mirror = {
        mirrored: false,
        reason: error instanceof Error ? error.message : "could not reach the enforcer",
      };
    }

    return NextResponse.json({ txHash, name: `${label}.${branch.name}`, ...mirror });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "transaction failed" },
      { status: 502 },
    );
  }
}
