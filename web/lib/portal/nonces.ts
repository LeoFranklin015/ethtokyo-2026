import "server-only";
import { randomBytes } from "node:crypto";

/**
 * One-time challenge nonces for portal sign-in.
 *
 * In memory on purpose: a nonce is worthless the moment it is used and meaningless after a
 * couple of minutes, so persisting it would buy nothing and cost a schema. A console restart
 * invalidates outstanding challenges, which is the safe direction to fail.
 *
 * Bound to the client IP as well as consumed on use, so a nonce handed to one device cannot be
 * redeemed by another that happened to observe it.
 */

const TTL_MS = 120_000;
const MAX_OUTSTANDING = 5_000;

type Entry = { ip: string; expires: number };
const outstanding = new Map<string, Entry>();

function sweep() {
  const now = Date.now();
  for (const [nonce, entry] of outstanding) {
    if (entry.expires <= now) outstanding.delete(nonce);
  }
}

export function issueNonce(ip: string): { nonce: string; expiresInSeconds: number } {
  sweep();
  // A crude ceiling, so a flood cannot grow this map without bound.
  if (outstanding.size >= MAX_OUTSTANDING) outstanding.clear();

  const nonce = randomBytes(24).toString("hex");
  outstanding.set(nonce, { ip, expires: Date.now() + TTL_MS });
  return { nonce, expiresInSeconds: Math.floor(TTL_MS / 1000) };
}

/** Consume a nonce. Returns false if unknown, expired, already used, or issued to another device. */
export function consumeNonce(nonce: string, ip: string): boolean {
  sweep();
  const entry = outstanding.get(nonce);
  if (!entry) return false;
  // Single use: delete whether or not the rest of the check passes, so a wrong-IP attempt
  // cannot be used to probe for valid nonces.
  outstanding.delete(nonce);
  if (entry.expires <= Date.now()) return false;
  return entry.ip === ip;
}

/** The exact string the wallet is asked to sign. Must match the client byte for byte. */
export function challengeMessage(nonce: string): string {
  return `Sign in to ENSCA\nNonce: ${nonce}`;
}
