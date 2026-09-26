"use client";
import useSWR from "swr";
import type { EnsMembership } from "@/lib/ens/read";
import type { IndexedBranch } from "@/lib/ens/indexer";


/** Chain reads go through our own route handlers, the same shape as the proxy hooks. */
async function ensGet<T>(path: string): Promise<T> {
  const res = await fetch(`/api/ens/${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`ENS ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

/** Memberships read from the branch registry, with their resolver entitlements. */
export function useEnsMemberships(org: string | null, branch?: string) {
  const { data, error, isLoading } = useSWR<{
    memberships: EnsMembership[];
    total: number;
    source: "indexer" | "chain";
    indexedBlock: number | null;
    /** Blocks behind the chain; `null` when either side could not be read. */
    lag: number | null;
    /** The index is too far behind to be read as settled fact. */
    stale: boolean;
  }>(
    // Keyed by organization as well as branch: two organizations must never share a cache
    // entry, and a null key means "nothing selected yet" rather than "fetch the default".
    org ? `ens-memberships:${org}:${branch ?? ""}` : null,
    () =>
      ensGet(
        `memberships?org=${org}${branch ? `&branch=${encodeURIComponent(branch)}` : ""}`,
      ),
    { refreshInterval: 30_000 },
  );
  return {
    memberships: data?.memberships,
    total: data?.total,
    source: data?.source,
    indexedBlock: data?.indexedBlock,
    lag: data?.lag ?? null,
    stale: data?.stale ?? false,
    error,
    isLoading,
  };
}

/** Branches under the organization, discovered from ENS rather than configured. */
/**
 * A branch as the console sees it, which is not quite as the indexer sees it.
 *
 * `source` says where the row came from. The indexer can be behind or stopped, and a branch it
 * has not reached is read from the chain instead — with no member count, because that figure is
 * the indexer's. Callers must be able to tell the two apart: a chain-sourced row is registered
 * and pending, not missing.
 */
export type ConsoleBranch = Omit<IndexedBranch, "memberCount"> & {
  memberCount: number | null;
  source: "indexer" | "chain";
};

export function useEnsBranches(org: string | null) {
  const { data, error, isLoading } = useSWR<{
    branches: ConsoleBranch[];
    indexedBlock: number | null;
  }>(org ? `ens-branches:${org}` : null, () => ensGet(`branches?org=${org}`), {
    refreshInterval: 60_000,
  });
  return { branches: data?.branches, indexedBlock: data?.indexedBlock, error, isLoading };
}
