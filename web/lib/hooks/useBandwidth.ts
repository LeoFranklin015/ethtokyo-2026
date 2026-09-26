"use client";
import useSWR from "swr";
import { apiGet } from "@/lib/api";

export type BandwidthSession = {
  id: string;
  ip: string;
  network_tier: string;
  ens_name: string | null;
  wallet_address: string | null;
  username: string;
  group_name: string;
  bytes_in: number;
  bytes_out: number;
  bytes_total: number;
  logged_in_at: number;
  logged_out_at: number | null;
};

export function useBandwidth(active = true) {
  return useSWR<{
    sessions: BandwidthSession[];
    tier_totals: Record<
      string,
      { sessions: number; bytes_in: number; bytes_out: number }
    >;
  }>(
    ["bandwidth", active],
    () => apiGet("bandwidth/sessions", { active: active ? "true" : "false" }),
    { refreshInterval: 10_000 }
  );
}
