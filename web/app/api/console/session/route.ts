import { NextRequest, NextResponse } from "next/server";

const CONSOLE_TOKEN = process.env.CONSOLE_TOKEN;

/**
 * Exchange the console token for a session cookie.
 *
 * The gate in `middleware.ts` accepts an `x-console-token` header or an `ensca_console` cookie.
 * A browser cannot attach a header to every `fetch` without threading the secret through client
 * code, which would put it in the bundle — so the browser gets a cookie instead, set once here
 * and never readable from JavaScript.
 *
 * Not matched by the middleware, deliberately: this is the one route that must be reachable
 * without already holding a session.
 */
export async function POST(req: NextRequest) {
  if (!CONSOLE_TOKEN) {
    return NextResponse.json({ error: "CONSOLE_TOKEN is not configured" }, { status: 503 });
  }

  const { token } = (await req.json().catch(() => ({}))) as { token?: string };
  if (!token || token.length !== CONSOLE_TOKEN.length || token !== CONSOLE_TOKEN) {
    return NextResponse.json({ error: "that token is not right" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set("ensca_console", CONSOLE_TOKEN, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 12,
  });
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.delete("ensca_console");
  return res;
}
