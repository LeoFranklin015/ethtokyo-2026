import { NextRequest, NextResponse } from "next/server";
import { namesOwnedBy } from "@/lib/ens/indexer";

export const dynamic = "force-dynamic";

/** Which `.eth` names does this wallet hold? */
export async function GET(req: NextRequest) {
  const owner = req.nextUrl.searchParams.get("owner");
  if (!owner || !/^0x[0-9a-fA-F]{40}$/.test(owner)) {
    return NextResponse.json({ error: "owner must be a wallet address" }, { status: 400 });
  }

  try {
    const names = await namesOwnedBy(owner);
    return NextResponse.json({ names });
  } catch (error) {
    // The indexer being unreachable is not "this wallet owns nothing" — the caller shows the
    // search box either way, and the search resolves ownership straight from the registry.
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "indexer read failed" },
      { status: 502 },
    );
  }
}
