"use client";
import useSWR from "swr";
import type { EnsBranch, EnsMembership } from "@/lib/ens/read";

/** Chain reads go through our own route handlers, the same shape as the proxy hooks. */
async function ensGet<T>(path: string): Promise<T> {
  const res = await fetch(`/api/ens/${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`ENS ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

/** Memberships read from the branch registry, with their resolver entitlements. */
export function useEnsMemberships() {
  const { data, error, isLoading } = useSWR<{
    memberships: EnsMembership[];
    total: number;
    source: "indexer" | "chain";
    indexedBlock: number | null;
  }>(
    "ens-memberships",
    () => ensGet("memberships"),
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
