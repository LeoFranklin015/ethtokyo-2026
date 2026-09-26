import { NextRequest, NextResponse } from "next/server";
import { COOKIE, read } from "@/lib/console-session";

/**
 * The enforcer's admin API, fronted.
 *
 * This is the only route that carries the enforcer's bearer token, which can mint more admin
 * tokens and rewrite any upstream — so it is also the only route that needs a gate. The gate is
 * the whole of the authorization check, deliberately in one place: the middleware used to hold a
 * second, different one, and two gates meant neither could be read as authoritative.
 *
 * What it asks is no longer "do you have the shared token" but "did you prove you own this
 * organization's name". `/api/console/session` does that proving against the registry.
 *
 * It asks *which* name only to record it: one enforcer serves one branch and has no organization
 * column, so any organization owner pointed at this deployment operates the same enforcer. That
 * is the enforcer's shape, not a gap in the check, and the console says so on screen.
 */

const ENFORCER_URL = process.env.ENFORCER_URL!;
const ENFORCER_TOKEN = process.env.ENFORCER_TOKEN!;

async function handler(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const session = read(req.cookies.get(COOKIE)?.value);
  if (!session) {
    return NextResponse.json(
      { error: "prove you own the organization to operate its enforcer" },
      { status: 401 },
    );
  }

  const { path } = await params;
  // Catch-all segments arrive percent-decoded, so `..%2f..%2fsecret` would escape /admin/ and
  // carry the bearer token to an endpoint outside it.
  if (path.some((seg) => seg.includes("/") || seg === ".." || seg.startsWith("."))) {
    return NextResponse.json({ error: "invalid path" }, { status: 400 });
  }
  const subpath = path.join("/");
  const search = req.nextUrl.search;
  const upstream = `${ENFORCER_URL}/admin/${subpath}${search}`;

  const headers: HeadersInit = {
    "Authorization": `Bearer ${ENFORCER_TOKEN}`,
    "Content-Type": req.headers.get("content-type") ?? "application/json",
  };

  const body = req.method !== "GET" && req.method !== "HEAD"
    ? await req.text()
    : undefined;

  let resp: Response;
  try {
    resp = await fetch(upstream, {
      method: req.method,
      headers,
      body,
      cache: "no-store",
      // An enforcer that never answers must not hold the request open forever; SWR would sit
      // in `isLoading` with nothing on screen to say why.
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    // A 502 is not a deny. The caller must be able to tell "the enforcer is down" from
    // "the enforcer said no".
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "enforcer unreachable" },
      { status: 502 },
    );
  }

  const data = await resp.text();
  return new NextResponse(data, {
    status: resp.status,
    headers: { "content-type": resp.headers.get("content-type") ?? "application/json" },
  });
}

export const GET = handler;
export const POST = handler;
export const PATCH = handler;
export const DELETE = handler;
export const PUT = handler;
