import { NextResponse } from "next/server";

const PROXY_URL = process.env.PROXY_URL!;

export async function GET() {
  const resp = await fetch(`${PROXY_URL}/status`, {
    cache: "no-store",
  });
  const data = await resp.text();
  return new NextResponse(data, {
    status: resp.status,
    headers: { "content-type": "application/json" },
  });
}
