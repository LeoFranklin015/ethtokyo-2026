import { NextRequest, NextResponse } from "next/server";
import { verifyMessage } from "viem";
import type { Address } from "viem";
import { resolveByWallet, resolveIdentity } from "@/lib/ens/read";
import { resolveOrg } from "@/lib/ens/org";
import { challengeMessage, consumeNonce } from "@/lib/portal/nonces";
import { admit } from "@/lib/portal/admit";
import { clientIp } from "../challenge/route";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Admit a device, on proof that the wallet controls the name.
 *
 * Four things must all hold, and the order matters — each step is cheap and rules out the next:
 *
 *   1. the nonce is one we issued to this device, unused and unexpired
 *   2. the signature recovers to the wallet the client claims
 *   3. the name resolves to a live membership in this organization
 *   4. that membership is owned by the recovered wallet
 *
 * Step 4 is the one the live Flask portal is missing entirely. It admits on a typed name, and an
 * ENS name is public — so today it is a bearer token.
 *
 * Failure semantics follow the project rule: a name that genuinely is not a member is a **403**
 * (a deny), while a chain read that did not answer is a **502** (not a deny). The caller must be
 * able to tell "you are not a member" from "we could not check", because the second must not
 * silently lock out a room full of people during an RPC blip.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    nonce?: string;
    signature?: string;
    wallet_address?: string;
    ens_name?: string;
  };

  const { nonce, signature, wallet_address: wallet, ens_name: ensName } = body;
  if (!nonce || !signature || !wallet) {
    return NextResponse.json(
      { ok: false, reason: "nonce, signature and wallet_address are required" },
      { status: 400 },
    );
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    return NextResponse.json({ ok: false, reason: "malformed wallet address" }, { status: 400 });
  }

  // 1 — the challenge
  if (!consumeNonce(nonce, clientIp(req))) {
    return NextResponse.json(
      { ok: false, reason: "that challenge is unknown, expired, or already used" },
      { status: 401 },
    );
  }

  // 2 — the signature
  let signatureValid = false;
  try {
    signatureValid = await verifyMessage({
      address: wallet as Address,
      message: challengeMessage(nonce),
      signature: signature as `0x${string}`,
    });
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    return NextResponse.json({ ok: false, reason: "signature did not match" }, { status: 401 });
  }

  // 3 — the membership. A throw here is an outage, not a deny.
  // The device has a wallet, not a name. Asking a person to type their own ENS name would be
  // worse UX and no stronger — a typed name proves nothing, which is how the current portal
  // ends up treating a public name as a password.
  let identity;
  try {
    if (ensName) {
      identity = await resolveIdentity(ensName);
    } else {
      // No name given, so we search this branch's organization. A portal serves one branch, so
      // that organization is configuration — there is nothing to guess and nothing to default.
      const orgLabel = process.env.BRANCH_ORG?.trim();
      if (!orgLabel) {
        return NextResponse.json(
          { ok: false, reason: "this portal has no organization configured" },
          { status: 503 },
        );
      }
      const org = await resolveOrg(orgLabel);
      if (!org) {
        return NextResponse.json(
          { ok: false, reason: `no organization is set up for ${orgLabel}.eth` },
          { status: 503 },
        );
      }
      identity = await resolveByWallet(wallet as Address, org);
    }
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        reason: error instanceof Error ? error.message : "could not reach the chain",
      },
      { status: 502 },
    );
  }
  if (!identity) {
    return NextResponse.json(
      { ok: false, reason: "that name is not a membership in this organization" },
      { status: 403 },
    );
  }

  // 4 — and it is theirs
  if (identity.owner.toLowerCase() !== wallet.toLowerCase()) {
    return NextResponse.json(
      { ok: false, reason: "that wallet does not own that name" },
      { status: 403 },
    );
  }

  // Admission itself. Until this call the person has only been *identified*; the thing that
  // puts them on the network is an iptables rule, and only the branch host can write one.
  // Reported separately so the page never claims a device is online when it is not.
  const admitted = await admit(clientIp(req), identity.name);

  return NextResponse.json({
    ok: true,
    admitted: admitted.ok,
    admissionError: admitted.reason,
    // An enforcer that did not answer is not an enforcer that said no, and the page words those
    // two very differently — one sends you to find an organizer, the other does not.
    admissionKind: admitted.kind ?? null,
    ens_name: identity.name,
    group_name: identity.entitlements["wifi.group"] ?? identity.role,
    role: identity.role,
    branch: identity.branch,
    // The tier is the enforcer's decision, not ours: ENS names the group, the branch decides
    // what that group is worth locally. Deliberately not returned from here.
    entitlements: identity.entitlements,
  });
}
