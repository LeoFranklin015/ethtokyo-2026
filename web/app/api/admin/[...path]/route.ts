import { NextRequest, NextResponse } from "next/server";

const PROXY_URL = process.env.PROXY_URL!;
const PROXY_ADMIN_TOKEN = process.env.PROXY_ADMIN_TOKEN!;

async function handler(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const subpath = path.join("/");
  const search = req.nextUrl.search;
  const upstream = `${PROXY_URL}/admin/${subpath}${search}`;

  const headers: HeadersInit = {
    "Authorization": `Bearer ${PROXY_ADMIN_TOKEN}`,
    "Content-Type": req.headers.get("content-type") ?? "application/json",
  };

  const body = req.method !== "GET" && req.method !== "HEAD"
    ? await req.text()
    : undefined;

  const resp = await fetch(upstream, {
    method: req.method,
    headers,
    body,
    cache: "no-store",
  });

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
