"use client";
import useSWR from "swr";
import { apiGet } from "@/lib/api";

/**
 * Groups as the enforcer knows them.
 *
 * Only what `/admin/groups` actually returns. An earlier version decorated each group with a
 * VLAN tag and a bandwidth pool from hardcoded tables, and computed a "used Mbps" by dividing a
 * cumulative lifetime byte counter by an assumed 60-second window. None of those three numbers
 * had a source; all of them rendered as measurements.
 */
export type EnforcerGroup = {
  id: string;
  name: string;
  network_tier: string;
  member_count: number;
  active_session_count: number;
};

/** Scoped: only the groups this organization has people in, counted over those people. */
export function useGroups(org: string | null) {
  const { data, isLoading, error } = useSWR<{ groups: EnforcerGroup[] }>(
    org ? ["groups", org] : null,
    () => apiGet("groups", { org: org! }),
    { refreshInterval: 30_000 },
  );
  return { data: data?.groups, isLoading, error };
}
