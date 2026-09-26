import { NextRequest, NextResponse } from "next/server";
import { namesOwnedBy } from "@/lib/ens/indexer";
import { orgStatus } from "@/lib/ens/org";

export const dynamic = "force-dynamic";

/**
 * The organizations this wallet could run.
 *
 * Every top-level `.eth` name it holds, each marked with whether it has been set up — because
 * owning a name and having an organization are different things, and the console's first
 * question is which one you are working in.
 */
export async function GET(req: NextRequest) {
  const owner = req.nextUrl.searchParams.get("owner");
  if (!owner || !/^0x[0-9a-fA-F]{40}$/.test(owner)) {
    return NextResponse.json({ error: "owner must be a wallet address" }, { status: 400 });
  }

  try {
    const names = await namesOwnedBy(owner);
    const roots = names.filter((n) => n.isTopLevel);

    const organizations = await Promise.all(
      roots.map(async (n) => {
        const status = await orgStatus(n.label).catch(() => null);
        return {
          label: n.label,
          name: n.name,
          expiry: n.expiry,
          // `null` means we could not check, which is not the same as "not set up".
          ready: status ? status.organization !== null : null,
          branchFactory: status?.organization?.branchFactory ?? null,
        };
      }),
    );

    return NextResponse.json({ organizations });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "could not list your names" },
      { status: 502 },
    );
  }
}
