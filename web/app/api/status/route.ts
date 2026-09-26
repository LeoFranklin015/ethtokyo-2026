import { NextResponse } from "next/server";

const ENFORCER_URL = process.env.ENFORCER_URL;

/**
 * Is the branch enforcer answering?
 *
 * The console's only health signal. It must distinguish "unreachable" from "unhealthy" and must
 * never throw — an unhandled throw here returns an HTML 500, which the client then fails to
 * parse as JSON, producing an error whose message has nothing to do with the cause.
 */
export async function GET() {
  if (!ENFORCER_URL) {
    return NextResponse.json({ error: "ENFORCER_URL is not configured" }, { status: 503 });
  }

  try {
    const resp = await fetch(`${ENFORCER_URL}/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    const data = await resp.text();
    return new NextResponse(data, {
      status: resp.status,
      headers: { "content-type": "application/json" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "enforcer unreachable" },
      { status: 502 },
    );
  }
}
