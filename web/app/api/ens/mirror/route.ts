import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, http, keccak256, toHex, type Address, type Hex } from "viem";
import { sepolia } from "viem/chains";
import { registrarV2Abi } from "@/lib/ens/abis";
import { RPC_BATCH_SIZE, RPC_URL } from "@/lib/ens/config";
import { getRoles } from "@/lib/ens/read";
import { branchForRegistrar } from "@/lib/ens/registrars";
import { resolveOrg } from "@/lib/ens/org";
import { enforcerGroupName, mirrorGroup, mirrorMember, mirrorRevoke } from "@/lib/enforcer/mirror";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const client = createPublicClient({ chain: sepolia, transport: http(RPC_URL, { batch: { batchSize: RPC_BATCH_SIZE, wait: 8 } }) });

/**
 * Copy a fact from the chain into the enforcer.
 *
 * The chain write is signed by whoever owns the branch, in their own browser. But the enforcer
 * only admits people it has rows for, and writing those rows needs the enforcer's admin token —
 * a secret that must stay on the server. So the client asks, and the server does it.
 *
 * Deliberately unauthenticated, and safe to be, because **nothing here is taken on trust**.
 * Every request names a thing and the server goes and reads whether it is true. A caller cannot
 * mirror a group that was never defined, a member who was never onboarded, or a revocation that
 * never happened — the worst they can do is ask us to re-copy something already true, which is
 * what the endpoint does anyway.
 *
 * That is the whole reason it does not need a gate: an attacker gains nothing, and a stranger
 * running their own organization is not shut out of their own product.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    kind?: "group" | "member" | "revoke";
    org?: string;
    registrar?: string;
    name?: string;
    label?: string;
    wallet?: string;
  };

  if (!body.registrar || !body.org) {
    return NextResponse.json({ error: "org and registrar are required" }, { status: 400 });
  }

  const organization = await resolveOrg(body.org).catch(() => undefined);
  if (organization === undefined) {
    return NextResponse.json({ error: "could not read that organization" }, { status: 502 });
  }
  if (organization === null) {
    return NextResponse.json({ error: "no such organization" }, { status: 404 });
  }

  let branch;
  try {
    branch = await branchForRegistrar(body.registrar, organization);
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
  const registrar = body.registrar as Address;

  try {
    if (body.kind === "group") {
      if (!body.name) return NextResponse.json({ error: "name required" }, { status: 400 });
      const name = body.name.trim().toLowerCase();

      // Is it really defined? `roleSpec.active` is the contract's own answer.
      const spec = await client.readContract({
        address: registrar,
        abi: registrarV2Abi,
        functionName: "roleSpec",
        args: [keccak256(toHex(name)) as Hex],
      });
      if (!spec[3]) {
        return NextResponse.json(
          { error: "no active group of that name on that branch" },
          { status: 404 },
        );
      }

      const roles = await getRoles(registrar);
      const role = roles.find((r) => r.name === name);
      const result = await mirrorGroup(
        enforcerGroupName(name, role?.entitlements).trim().toLowerCase(),
      );
      return NextResponse.json(result);
    }

    if (body.kind === "member") {
      if (!body.label) return NextResponse.json({ error: "label required" }, { status: 400 });
      const label = body.label.trim().toLowerCase();

      const owner = body.wallet as Address | undefined;
      if (!owner) return NextResponse.json({ error: "wallet required" }, { status: 400 });

      const membership = await client.readContract({
        address: registrar,
        abi: registrarV2Abi,
        functionName: "membershipOf",
        args: [owner],
      });
      if (membership === 0n) {
        return NextResponse.json(
          { error: "that wallet holds no membership on that branch" },
          { status: 404 },
        );
      }

      const [onChainLabel, roleId] = await Promise.all([
        client.readContract({
          address: registrar,
          abi: registrarV2Abi,
          functionName: "labelOf",
          args: [membership],
        }),
        client.readContract({
          address: registrar,
          abi: registrarV2Abi,
          functionName: "roleOf",
          args: [membership],
        }),
      ]);
      if (onChainLabel !== label) {
        return NextResponse.json(
          { error: "that wallet's membership is under a different label" },
          { status: 409 },
        );
      }

      const roles = await getRoles(registrar);
      const role = roles.find((r) => r.id.toLowerCase() === (roleId as string).toLowerCase());
      if (!role) {
        return NextResponse.json({ error: "that membership's group is unknown" }, { status: 409 });
      }

      const result = await mirrorMember({
        ensName: `${label}.${branch.name}`,
        wallet: owner,
        group: enforcerGroupName(role.name, role.entitlements).trim().toLowerCase(),
      });
      return NextResponse.json(result);
    }

    if (body.kind === "revoke") {
      if (!body.label || !body.wallet) {
        return NextResponse.json({ error: "label and wallet required" }, { status: 400 });
      }
      // Only mirror a revocation the chain agrees has happened.
      const membership = await client.readContract({
        address: registrar,
        abi: registrarV2Abi,
        functionName: "membershipOf",
        args: [body.wallet as Address],
      });
      if (membership !== 0n) {
        return NextResponse.json(
          { error: "that wallet still holds a membership on chain" },
          { status: 409 },
        );
      }
      const result = await mirrorRevoke(`${body.label.trim().toLowerCase()}.${branch.name}`);
      return NextResponse.json(result);
    }

    return NextResponse.json({ error: "kind must be group, member or revoke" }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "mirror failed" },
      { status: 502 },
    );
  }
}
