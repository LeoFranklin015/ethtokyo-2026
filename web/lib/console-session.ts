import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Who is allowed to operate the enforcer.
 *
 * There is no console password any more. The only credential that means anything here is the
 * one that already means something everywhere else in this product: the wallet that owns the
 * organization's `.eth` name. A shared token could be pasted to anyone, had to be provisioned
 * out of band, and said nothing about *which* organization the holder ran — so it was a weaker
 * check sitting in front of a stronger one that the chain already performs.
 *
 * This module only carries a proven claim across requests. The proving — signature plus an
 * on-chain ownership read — happens in `/api/console/session`, once.
 */

export type ConsoleSession = {
  /** The wallet that signed. */
  address: string;
  /** The `.eth` label it owns, e.g. `acme`. */
  org: string;
  /** Seconds since the epoch. */
  exp: number;
};

export const COOKIE = "ensca_console";
export const NONCE_COOKIE = "ensca_nonce";
const TTL_SECONDS = 60 * 60 * 12;

/**
 * Unset means sessions do not survive a restart, which is a nuisance rather than a hole. The
 * alternative — a fixed default — would let anyone who has read this file mint a session.
 */
const SECRET = process.env.CONSOLE_SESSION_SECRET || randomBytes(32).toString("hex");

export function issue(address: string, org: string): { value: string; maxAge: number } {
  const session: ConsoleSession = {
    address: address.toLowerCase(),
    org: org.toLowerCase(),
    exp: Math.floor(Date.now() / 1000) + TTL_SECONDS,
  };
  const body = Buffer.from(JSON.stringify(session)).toString("base64url");
  return { value: `${body}.${mac(body)}`, maxAge: TTL_SECONDS };
}

/** `null` for anything that is not a currently valid session — tampered, expired or absent. */
export function read(cookie: string | undefined): ConsoleSession | null {
  if (!cookie) return null;
  const dot = cookie.lastIndexOf(".");
  if (dot <= 0) return null;

  const body = cookie.slice(0, dot);
  const presented = Buffer.from(cookie.slice(dot + 1), "hex");
  const expected = Buffer.from(mac(body), "hex");
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;

  try {
    const session = JSON.parse(Buffer.from(body, "base64url").toString()) as ConsoleSession;
    if (typeof session.exp !== "number" || session.exp * 1000 < Date.now()) return null;
    return session;
  } catch {
    return null;
  }
}

export function newNonce(): string {
  return randomBytes(16).toString("hex");
}

/** What the wallet is asked to sign. Both sides build it from the same pieces. */
export function challenge(params: {
  address: string;
  org: string;
  nonce: string;
  issuedAt: string;
}): string {
  return [
    "Radius console",
    "",
    `Organization: ${params.org}.eth`,
    `Address: ${params.address}`,
    `Issued: ${params.issuedAt}`,
    `Nonce: ${params.nonce}`,
    "",
    `Signing proves you own ${params.org}.eth. It authorises no transaction and costs nothing.`,
  ].join("\n");
}

function mac(body: string): string {
  return createHmac("sha256", SECRET).update(body).digest("hex");
}
