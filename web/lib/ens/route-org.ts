import "server-only";
import { NextResponse } from "next/server";
import { resolveOrg, type Organization } from "./org";

/**
 * Resolve the `?org=` every organization-scoped route needs.
 *
 * Returns either the organization or the response to send instead, so callers cannot forget the
 * three cases. The distinction between them is the whole point:
 *
 *   - **400** — no organization was named. There is no default any more, because defaulting is
 *     how one tenant's console ended up answering with another's branches.
 *   - **404** — that name has no organization. A definite answer.
 *   - **502** — we could not find out. Not a denial, and callers must not render it as one.
 */
export async function orgFromRequest(
  url: URL,
): Promise<{ org: Organization; error?: never } | { org?: never; error: NextResponse }> {
  const label = url.searchParams.get("org");
  if (!label) {
    return {
      error: NextResponse.json(
        { error: "org is required — name the organization to read" },
        { status: 400 },
      ),
    };
  }

  try {
    const org = await resolveOrg(label);
    if (!org) {
      return {
        error: NextResponse.json(
          { error: `no organization has been set up for ${label.replace(/\.eth$/, "")}.eth` },
          { status: 404 },
        ),
      };
    }
    return { org };
  } catch (e) {
    return {
      error: NextResponse.json(
        { error: e instanceof Error ? e.message : "could not read that organization" },
        { status: 502 },
      ),
    };
  }
}
