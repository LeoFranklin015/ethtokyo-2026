/**
 * The id a member's badge carries.
 *
 * A badge encodes a URL whose last path segment is the id — `https://something/sdiuf` is the
 * member `sdiuf` — and that id becomes their ENS label, so it is validated here rather than
 * trusted: whatever a camera happens to decode is about to be minted on-chain.
 */
export const MEMBER_ID_PATTERN = /^[a-z0-9]{5}$/;

export function parseMemberId(scanned: string): string | null {
  const text = scanned.trim();
  if (!text) return null;

  // Only the path matters, so a query string or fragment is dropped before splitting. The text
  // is not necessarily a URL — a badge printed with the bare id still works.
  const path = text.split(/[?#]/, 1)[0];
  const segments = path.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  if (!last) return null;

  const id = last.toLowerCase();
  return MEMBER_ID_PATTERN.test(id) ? id : null;
}
