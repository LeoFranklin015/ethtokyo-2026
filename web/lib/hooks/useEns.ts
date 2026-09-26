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
    error,
    isLoading,
  };
}

/** Branches under the organization, discovered from ENS rather than configured. */
export function useEnsBranches(org: string | null) {
  const { data, error, isLoading } = useSWR<{
    branches: IndexedBranch[];
    indexedBlock: number | null;
  }>(org ? `ens-branches:${org}` : null, () => ensGet(`branches?org=${org}`), {
    refreshInterval: 60_000,
  });
  return { branches: data?.branches, indexedBlock: data?.indexedBlock, error, isLoading };
}
