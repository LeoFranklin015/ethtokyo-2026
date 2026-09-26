import { NextResponse } from "next/server";
import { getBranch } from "@/lib/ens/read";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getBranch());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "chain read failed" },
      { status: 502 },
    );
  }
}
