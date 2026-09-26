"use client";
import useSWR from "swr";
import type { EnsBranch, EnsMembership } from "@/lib/ens/read";
import type { IndexedBranch } from "@/lib/ens/indexer";

/** Chain reads go through our own route handlers, the same shape as the proxy hooks. */
async function ensGet<T>(path: string): Promise<T> {
  const res = await fetch(`/api/ens/${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`ENS ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

/** Memberships read from the branch registry, with their resolver entitlements. */
export function useEnsMemberships(branch?: string) {
  const { data, error, isLoading } = useSWR<{
    memberships: EnsMembership[];
    total: number;
    source: "indexer" | "chain";
    indexedBlock: number | null;
  }>(
    branch ? `ens-memberships:${branch}` : "ens-memberships",
    () => ensGet(branch ? `memberships?branch=${encodeURIComponent(branch)}` : "memberships"),
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

/** The branch itself, plus the organization's on-chain role catalogue. */
export function useEnsBranch() {
  const { data, error, isLoading } = useSWR<EnsBranch>(
    "ens-branch",
    () => ensGet("branch"),
    { refreshInterval: 60_000 },
  );
  return { branch: data, error, isLoading };
}

/** Branches under the organization, discovered from ENS rather than configured. */
export function useEnsBranches() {
  const { data, error, isLoading } = useSWR<{
    branches: IndexedBranch[];
    indexedBlock: number | null;
  }>("ens-branches", () => ensGet("branches"), { refreshInterval: 60_000 });
  return { branches: data?.branches, indexedBlock: data?.indexedBlock, error, isLoading };
}
