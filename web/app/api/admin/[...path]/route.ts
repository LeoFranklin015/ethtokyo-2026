import { NextRequest, NextResponse } from "next/server";

const ENFORCER_URL = process.env.ENFORCER_URL!;
const ENFORCER_TOKEN = process.env.ENFORCER_TOKEN!;

async function handler(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
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
