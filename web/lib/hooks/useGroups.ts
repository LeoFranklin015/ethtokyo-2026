"use client";
import useSWR from "swr";
import { apiGet } from "@/lib/api";
import type { Group } from "@/lib/data";
import { TIER_POOL_MBPS, TIER_VLAN } from "@/lib/config";

type ApiGroup = {
  id: string;
  name: string;
  network_tier: string;
  member_count: number;
  active_session_count: number;
};

type BandwidthTierTotals = Record<
  string,
  { sessions: number; bytes_in: number; bytes_out: number }
>;

export function useGroups() {
  const groups = useSWR<{ groups: ApiGroup[] }>(
    "groups",
    () => apiGet("groups"),
    { refreshInterval: 30_000 }
  );
  const bw = useSWR<{ sessions: unknown[]; tier_totals: BandwidthTierTotals }>(
    "bandwidth-sessions",
    () => apiGet("bandwidth/sessions", { active: "true" }),
    { refreshInterval: 30_000 }
  );

  const data: Group[] | undefined =
    groups.data && bw.data
      ? groups.data.groups.map((g) => {
          const tier = g.network_tier;
          const tierBw = bw.data!.tier_totals[tier];
          // Approximate used Mbps: bytes_out over last session window * 8 / 60s / 1e6
          const used = tierBw
            ? Math.round((tierBw.bytes_out * 8) / (60 * 1_000_000))
            : 0;
          return {
            id: g.id,
            name: g.name,
            network_tier: tier,
            member_count: g.member_count,
            active_session_count: g.active_session_count,
            vlan: TIER_VLAN[tier] ?? 0,
            pool: TIER_POOL_MBPS[tier] ?? 100,
            used,
            devices: g.active_session_count,
          };
        })
      : undefined;

  return {
    data,
    isLoading: groups.isLoading || bw.isLoading,
    error: groups.error ?? bw.error,
  };
}
