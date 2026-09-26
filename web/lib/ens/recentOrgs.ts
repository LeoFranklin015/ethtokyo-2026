"use client";

/**
 * Organizations this browser has already been in.
 *
 * The console's list of organizations comes from the ENS indexer, which can be behind or
 * stopped — and when it is, a name registered since its last block is absent from that list
 * entirely, along with any organization built on it. Somebody who set one up minutes ago was
 * told, in effect, that it did not exist.
 *
 * So the browser remembers. This is a hint, never an authority: every remembered label is
 * verified against the registry before it is shown, so a name that was transferred away, or
 * never set up, does not linger in the list on the strength of this alone.
 */

const KEY = "ensca.recent-orgs";
const LIMIT = 12;

export function recentOrgs(): string[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    // A browser refusing storage — private mode, blocked site data — is not worth an error
    // state. The indexer's list still works; this only ever adds to it.
    return [];
  }
}

export function rememberOrg(label: string): void {
  const clean = label.trim().toLowerCase().replace(/\.eth$/, "");
  if (!/^[a-z0-9-]{1,32}$/.test(clean)) return;
  try {
    const next = [clean, ...recentOrgs().filter((l) => l !== clean)].slice(0, LIMIT);
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Same as above: remembering is a convenience, and failing to is not an error.
  }
}
