import { NextRequest, NextResponse } from "next/server";
import { namesOwnedBy } from "@/lib/ens/indexer";
import { orgStatus } from "@/lib/ens/org";
import { orgCandidatesByOwner } from "@/lib/enforcer/ens-names";

export const dynamic = "force-dynamic";

/**
 * The organizations this wallet could run.
 *
 * Every top-level `.eth` name it holds, each marked with whether it has been set up — because
 * owning a name and having an organization are different things, and the console's first
 * question is which one you are working in.
 *
 * Two sources, tried in order:
 *  1. ENS indexer — knows about every name the wallet holds, but lags the chain.
 *  2. Enforcer ens_names table — knows only names registered *through this console*, but does
 *     not depend on the indexer. Each candidate is still verified on chain before it is shown.
 *
 * When the indexer is down the org picker still shows organizations the operator registered
 * here. Names registered elsewhere (ENS app, another console) only appear once the indexer
 * recovers, since there is nowhere else to look for them.
 */
export async function GET(req: NextRequest) {
  const owner = req.nextUrl.searchParams.get("owner");
  if (!owner || !/^0x[0-9a-fA-F]{40}$/.test(owner)) {
    return NextResponse.json({ error: "owner must be a wallet address" }, { status: 400 });
  }

  // Try the indexer first.
  const indexed = await namesOwnedBy(owner).catch(() => null);
  let labels: string[];
  let fromIndexer = true;

  if (indexed !== null) {
    labels = indexed.filter((n) => n.isTopLevel).map((n) => n.label);
  } else {
    // Indexer is down — fall back to names the console recorded locally.
    const candidates = await orgCandidatesByOwner(owner);
    labels = candidates;
    fromIndexer = false;
  }

  const organizations = await Promise.all(
    labels.map(async (label) => {
      const status = await orgStatus(label).catch(() => null);
      const indexedEntry = indexed?.find((n) => n.label === label);
      return {
        label,
        name: `${label}.eth`,
        expiry: indexedEntry?.expiry ?? null,
        // `null` means we could not check, which is not the same as "not set up".
        ready: status ? status.organization !== null : null,
        branchFactory: status?.organization?.branchFactory ?? null,
      };
    }),
  );

  return NextResponse.json({ organizations, indexerAvailable: fromIndexer });
}
