import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

const SCRAPER_URL = process.env.SCRAPER_URL ?? "http://172.16.0.130:8090";

export async function GET(req: NextRequest) {
  const url = (req.nextUrl.searchParams.get("url") ?? "").trim();
  if (!url) {
    return NextResponse.json({ error: "url required" }, { status: 400 });
  }
  try {
    const res = await fetch(
      `${SCRAPER_URL}/scrape?url=${encodeURIComponent(url)}`,
      { signal: AbortSignal.timeout(12000) },
    );
    if (!res.ok) return NextResponse.json({ name: null, image: null });
    const body = await res.json() as { name?: string; image?: string };
    return NextResponse.json({ name: body.name ?? null, image: body.image ?? null });
  } catch {
    return NextResponse.json({ name: null, image: null });
  }
}
