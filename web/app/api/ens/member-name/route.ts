import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, http, isAddress, type Address } from "viem";
import { sepolia } from "viem/chains";
import { orgRegistrarAbi } from "@/lib/ens/abis";
import { RPC_BATCH_SIZE, RPC_URL } from "@/lib/ens/config";
import { labelAvailable } from "@/lib/ens/availability";
import { resolveOrg } from "@/lib/ens/org";

export const dynamic = "force-dynamic";

const ID = /^[a-z0-9-]{1,32}$/;

/**
 * Can this badge id be minted as this wallet's organization-wide Member name?
 *
 * Onboarding writes the badge id twice: once as the branch subname, and once — via
 * `ensureMember` — as the Member name in the organization's own registry. Branch names live in
 * that same registry, so an id equal to an existing branch label makes `ensureMember` revert
 * `LabelUnavailable` and takes the whole onboarding transaction with it, after the operator has
 * already signed.
 *
 * The question is conditional, which is why it is asked here rather than inferred from an
 * availability check alone: `ensureMember` returns early for a wallet that already holds a
 * Member name, so for them a taken label is irrelevant and refusing would be wrong.
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const orgLabel = (params.get("org") ?? "").trim().toLowerCase();
  const id = (params.get("id") ?? "").trim().toLowerCase();
  const wallet = params.get("wallet") ?? "";

  if (!ID.test(orgLabel) || !ID.test(id) || !isAddress(wallet)) {
    return NextResponse.json({ error: "org, id and wallet are required" }, { status: 400 });
  }

  try {
    const org = await resolveOrg(orgLabel);
    if (!org) {
      return NextResponse.json({ error: `no organization is set up for ${orgLabel}.eth` }, { status: 404 });
    }

    const client = createPublicClient({
      chain: sepolia,
      transport: http(RPC_URL, { batch: { batchSize: RPC_BATCH_SIZE, wait: 8 } }),
    });

    const [existingResource, idFree] = await Promise.all([
      client.readContract({
        address: org.orgRegistrar,
        abi: orgRegistrarAbi,
        functionName: "memberOf",
        args: [wallet as Address],
      }) as Promise<bigint>,
      labelAvailable(org.registry, id),
    ]);

    const alreadyAMember = existingResource !== 0n;
    return NextResponse.json({
      alreadyAMember,
      idFree,
      // The only combination that cannot be onboarded.
      blocked: !alreadyAMember && !idFree,
    });
  } catch (error) {
    // Unreadable is not "taken". The form shows this as a failed check, never as a refusal.
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "could not check that id" },
      { status: 502 },
    );
  }
}
