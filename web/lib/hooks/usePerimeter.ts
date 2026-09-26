"use client";

import { useSearchParams } from "next/navigation";

/**
 * Which perimeter is this console looking at?
 *
 * The same shape as `useOrg`, and for the same reason: a perimeter held in component state
 * cannot be linked to, bookmarked or reloaded, and every page that reads one would have to be
 * told about it through a provider. It lives in `?perimeter=` instead, beside `?org=`.
 *
 * `null` is a legitimate state — nothing chosen yet — and is deliberately not the same thing as
 * "this organization has no perimeters", which only a read of the registry can say.
 */
export function usePerimeter(): string | null {
  const params = useSearchParams();
  const raw = params.get("perimeter")?.trim().toLowerCase();
  // A perimeter is an ENS label, so the same alphabet as an organization label with room for a
  // longer word.
  return raw && /^[a-z0-9-]{1,63}$/.test(raw) ? raw : null;
}

/** Preserve both the organization and the perimeter across console links. */
export function withScope(href: string, org: string | null, perimeter: string | null): string {
  const query = new URLSearchParams();
  if (org) query.set("org", org);
  if (perimeter) query.set("perimeter", perimeter);
  const search = query.toString();
  return search ? `${href}?${search}` : href;
}
