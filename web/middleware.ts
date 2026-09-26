import { NextRequest, NextResponse } from "next/server";

/**
 * The gate in front of everything privileged.
 *
 * Two surfaces need it, for the same reason: both spend a credential the caller does not hold.
 *
 *   /api/admin/*  attaches the enforcer's admin bearer token to whatever arrives. Ungated, an
 *                 anonymous browser could POST /api/admin/tokens and mint itself a permanent
 *                 admin token, rewrite a resource's upstream URL, or revoke every session.
 *   /api/ens/*    writes are signed by ORG_PRIVATE_KEY, the organization's root key. Ungated,
 *                 anyone could onboard themselves into any group.
 *
 * Reads of /api/ens/* stay open on purpose: `/api/ens/resolve` is the enforcer's admission
 * lookup and must answer without a console session, and the rest is public ENS data anyway.
 */

const CONSOLE_TOKEN = process.env.CONSOLE_TOKEN;
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function unauthorized(reason: string) {
  return NextResponse.json({ error: reason }, { status: 401 });
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const isAdmin = pathname.startsWith("/api/admin");
  const isEnsWrite = pathname.startsWith("/api/ens") && WRITE_METHODS.has(req.method);
  if (!isAdmin && !isEnsWrite) return NextResponse.next();

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
  matcher: ["/api/admin/:path*", "/api/ens/:path*"],
};
