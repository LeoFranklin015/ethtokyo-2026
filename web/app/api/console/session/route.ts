import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, http, isAddress, type Address, type Hex } from "viem";
import { sepolia } from "viem/chains";
import { RPC_BATCH_SIZE, RPC_URL } from "@/lib/ens/config";
import { orgStatus } from "@/lib/ens/org";
import { COOKIE, NONCE_COOKIE, challenge, issue, newNonce, read } from "@/lib/console-session";

export const dynamic = "force-dynamic";

/**
 * Prove you own the organization.
 *
 * Replaces a shared console token. The wallet signs a one-shot challenge; the server checks the
 * signature and then reads the `.eth` registry to see whether that wallet actually holds the
 * name. Only then does it hand back a session, which is what lets the admin proxy attach the
 * enforcer's token.
 *
 * Nothing about this is a second opinion on the chain. It is the same question the contracts
 * ask, asked once, so that the enforcer — which knows nothing about ENS — can be operated by
 * the person the chain already says is in charge.
 */

const client = createPublicClient({
  chain: sepolia,
  transport: http(RPC_URL, { batch: { batchSize: RPC_BATCH_SIZE, wait: 8 } }),
});

const secureCookie = process.env.CONSOLE_INSECURE_COOKIE !== "1";

/**
 * The current session, and — given a wallet and a name — the exact text to sign.
 *
 * The challenge is built here and nowhere else. When both sides composed it from the same
 * pieces, any divergence in wording produced a signature that verified against a message the
 * signer never saw the server's version of, and the only symptom was a flat refusal.
 */
export async function GET(req: NextRequest) {
  const session = read(req.cookies.get(COOKIE)?.value);
  const nonce = newNonce();
  const issuedAt = new Date().toISOString();

  const address = req.nextUrl.searchParams.get("address");
  const org = (req.nextUrl.searchParams.get("org") ?? "").trim().toLowerCase().replace(/\.eth$/, "");
  const message =
    address && isAddress(address) && /^[a-z0-9-]{1,32}$/.test(org)
      ? challenge({ address, org, nonce, issuedAt })
      : null;

  const res = NextResponse.json({
    session: session ? { address: session.address, org: session.org, exp: session.exp } : null,
    nonce,
    issuedAt,
    message,
  });
  res.cookies.set(NONCE_COOKIE, nonce, {
    httpOnly: true,
    sameSite: "strict",
    secure: secureCookie,
    path: "/",
    maxAge: 300,
  });
  return res;
}

/**
 * Every answer here spends the nonce, refusals included. A challenge that survived a failed
 * attempt could be retried for the five minutes it stayed fresh, which is not what "one-shot"
 * means even if nothing downstream would have accepted it.
 */
function spent(body: unknown, status: number) {
  const res = NextResponse.json(body, { status });
  res.cookies.delete(NONCE_COOKIE);
  return res;
}

export async function POST(req: NextRequest) {
  const { address, org, signature, issuedAt, nonce } = (await req.json().catch(() => ({}))) as {
    address?: string;
    org?: string;
    signature?: string;
    issuedAt?: string;
    nonce?: string;
  };

  if (!address || !isAddress(address) || !org || !signature || !issuedAt || !nonce) {
    return spent({ error: "address, org, issuedAt, nonce and signature are required" }, 400);
  }

  // The nonce has to be one we just issued, to this browser, and it is spent either way.
  const expectedNonce = req.cookies.get(NONCE_COOKIE)?.value;
  if (!expectedNonce || expectedNonce !== nonce) {
    return spent({ error: "that challenge has expired — try again" }, 400);
  }

  const age = Date.now() - Date.parse(issuedAt);
  if (!Number.isFinite(age) || age < -60_000 || age > 300_000) {
    return spent({ error: "that challenge has expired — try again" }, 400);
  }

  const label = org.trim().toLowerCase().replace(/\.eth$/, "");
  if (!/^[a-z0-9-]{1,32}$/.test(label)) {
    return spent({ error: "that is not an organization name" }, 400);
  }

  let valid: boolean;
  try {
    // `verifyMessage` on a client, not the standalone helper, so a smart-contract wallet
    // authenticates through ERC-1271 rather than being told its signature is malformed.
    valid = await client.verifyMessage({
      address: address as Address,
      message: challenge({ address, org: label, nonce, issuedAt }),
      signature: signature as Hex,
    });
  } catch {
    valid = false;
  }
  if (!valid) {
    return spent({ error: "that signature is not from this wallet" }, 401);
  }

  let owner: string | null;
  try {
    owner = (await orgStatus(label)).owner;
  } catch (error) {
    // Not a refusal. If the registry cannot be read, nobody is told they do not own their name.
    return spent({ error: error instanceof Error ? error.message : "could not read the registry" }, 502);
  }

  if (!owner || owner.toLowerCase() !== address.toLowerCase()) {
    return spent({ error: `${label}.eth is not owned by this wallet` }, 403);
  }

  const { value, maxAge } = issue(address, label);
  const res = NextResponse.json({ session: { address: address.toLowerCase(), org: label } });
  res.cookies.set(COOKIE, value, {
    httpOnly: true,
    sameSite: "strict",
    secure: secureCookie,
    path: "/",
    maxAge,
  });
  res.cookies.delete(NONCE_COOKIE);
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ session: null });
  res.cookies.delete(COOKIE);
  return res;
}
