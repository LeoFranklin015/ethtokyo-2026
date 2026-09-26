import { NextResponse } from "next/server";
import { getIndexedBranches, getIndexerStatus } from "@/lib/ens/indexer";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [branches, indexer] = await Promise.all([getIndexedBranches(), getIndexerStatus()]);
    return NextResponse.json({ branches, indexedBlock: indexer?.block ?? null });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "indexer read failed" },
      { status: 502 },
    );
  }
}
