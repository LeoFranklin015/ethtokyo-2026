import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, http, type Address } from "viem";
import { sepolia } from "viem/chains";
import { orgFactoryAbi } from "@/lib/ens/abis";
import { ENS, RPC_BATCH_SIZE, RPC_URL } from "@/lib/ens/config";
import { getIndexedBranches, getIndexerStatus } from "@/lib/ens/indexer";
import { chainBranches } from "@/lib/ens/read";

export const dynamic = "force-dynamic";

/**
 * Every branch this organization has opened.
 *
 * Two sources, merged, because they fail in opposite directions. The indexer answers in one
 * query and carries member counts, but runs minutes behind the chain — so a branch opened a
 * moment ago is missing from it. The factory's `BranchCreated` logs are visible in the block
 * the branch was created in, but carry nothing else.
 *
 * This used to be indexer-only, which meant an operator who had just opened a branch could not
 * see it, could not define a group on it, and could not onboard anyone into it — for as long as
 * the indexer took to catch up. Every console screen that picks a branch reads this route.
 */
const client = createPublicClient({
  chain: sepolia,
  transport: http(RPC_URL, { batch: { batchSize: RPC_BATCH_SIZE, wait: 8 } }),
});

export async function GET(req: NextRequest) {
  // `?org=acme` scopes the list to that organization's own contracts. Without it the answer is
  // the configured organization's branches — which is wrong the moment somebody stands up
  // their own, and is how a branch you had just created failed to appear in its own wizard.
  const orgLabel = req.nextUrl.searchParams.get("org");
  let scope;
  if (orgLabel) {
    try {
      const found = (await client.readContract({
        address: ENS.orgFactory as Address,
        abi: orgFactoryAbi,
        functionName: "organizationFor",
        args: [orgLabel],
      })) as { registry: Address; resolver: Address; branchFactory: Address };

      if (found.branchFactory === "0x0000000000000000000000000000000000000000") {
        return NextResponse.json(
          { error: `no organization has been set up for ${orgLabel}.eth` },
          { status: 404 },
        );
      }
      scope = {
        factory: found.branchFactory,
        orgRegistry: found.registry,
        orgResolver: found.resolver,
        organization: `${orgLabel}.eth`,
      };
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "could not read that organization" },
        { status: 502 },
      );
    }
  }

  const [indexed, fromChain, indexer] = await Promise.all([
    // The indexer only knows the configured organization's tree, so it is skipped when a
    // different one is asked for rather than returning that one's branches by mistake.
    (scope
      ? Promise.resolve([] as Awaited<ReturnType<typeof getIndexedBranches>>)
      : getIndexedBranches()
    ).catch((error: unknown) => error as Error),
    chainBranches(scope).catch((error: unknown) => error as Error),
    getIndexerStatus().catch(() => null),
  ]);

  const indexedOk = !(indexed instanceof Error);
  const chainOk = !(fromChain instanceof Error);

  // Both sources gone means we genuinely do not know. Say so rather than answering "none",
  // which a caller cannot tell from an organization with no branches.
  if (!indexedOk && !chainOk) {
    return NextResponse.json(
      { error: (indexed as Error).message || "no branch source could be read" },
      { status: 502 },
    );
  }

  const merged = new Map<string, Record<string, unknown>>();
  if (chainOk) {
    for (const b of fromChain) {
      merged.set(b.label, { ...b, memberCount: null, source: "chain" });
    }
  }
  if (indexedOk) {
    // The indexer's row wins where it exists: same identity, more detail.
    for (const b of indexed) merged.set(b.label, { ...b, source: "indexer" });
  }

  return NextResponse.json({
    branches: [...merged.values()].sort((a, b) =>
      String(a.label).localeCompare(String(b.label)),
    ),
    indexedBlock: indexer?.block ?? null,
    // So the console can say "this branch is too new to be indexed" rather than showing a row
    // with blanks and leaving the operator to guess.
    indexerAvailable: indexedOk,
  });
}
