import { NextRequest, NextResponse } from "next/server";
import { ENS } from "@/lib/ens/config";
import { orgStatus } from "@/lib/ens/org";

export const dynamic = "force-dynamic";

/**
 * What is `?name=acme.eth`?
 *
 * Answers who owns it and whether it has been set up as an organization. This used to return a
 * hardcoded organization name and the server's signing address — both of which are gone, along
 * with the idea that this console serves one organization.
 */
export async function GET(req: NextRequest) {
  const name = req.nextUrl.searchParams.get("name");
  if (!name) {
    return NextResponse.json({ chainId: 11155111, orgFactory: ENS.orgFactory });
  }

  try {
    return NextResponse.json(await orgStatus(name));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "could not read that name" },
      { status: 502 },
    );
  }
}
