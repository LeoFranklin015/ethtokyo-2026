import { NextRequest, NextResponse } from "next/server";

/**
 * The gate in front of everything privileged.
 *
 * One surface needs it: `/api/admin/*` attaches the enforcer's admin bearer token to whatever
 * arrives. Ungated, an anonymous browser could POST /api/admin/tokens and mint itself a
 * permanent admin token, rewrite a resource's upstream URL, or revoke every session.
 *
 * `/api/ens/*` is deliberately open, reads and writes alike. There is no server wallet any
 * more: every ENS write is signed by the person making it, and the contracts check whether that
 * wallet holds the role — `ROLE_CREATE_BRANCH`, `ROLE_ROLE_EDIT`, `ROLE_MINT`. Gating it here
 * would add a weaker check in front of a stronger one, and would stop anyone but us from
 * running an organization, which is the opposite of the point.
 *
 * `/api/ens/mirror` writes to the enforcer but verifies every claim against the chain first, so
 * it needs no gate either — see its own comment.
 */

const CONSOLE_TOKEN = process.env.CONSOLE_TOKEN;
function unauthorized(reason: string) {
  return NextResponse.json({ error: reason }, { status: 401 });
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  // The sign-in route itself must be reachable without a session.
  if (pathname.startsWith("/api/console/session")) return NextResponse.next();

  if (!pathname.startsWith("/api/admin")) return NextResponse.next();

  // Fail closed. An unset token must not mean "no gate" — that is how this was open to begin
  // with, and a misconfigured deployment should refuse rather than expose the org key.
  if (!CONSOLE_TOKEN) {
    return NextResponse.json(
      { error: "CONSOLE_TOKEN is not configured; privileged routes are disabled" },
      { status: 503 },
    );
  }

  const presented =
    req.headers.get("x-console-token") ??
    req.cookies.get("ensca_console")?.value ??
    "";

  // Length-independent compare. Not constant-time — Edge middleware has no timingSafeEqual —
  // but the token is 32+ random bytes, so a timing oracle is not the cheapest attack here.
  if (presented.length !== CONSOLE_TOKEN.length || presented !== CONSOLE_TOKEN) {
    return unauthorized("console authentication required");
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/api/admin/:path*", "/api/console/:path*"],
};
