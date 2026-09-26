"use client";
import useSWR from "swr";
import { apiGet } from "@/lib/api";

export type ApiSession = {
  id: string;
  user_id: string;
  username: string;
  group_id: string;
  group_name: string;
  ip: string;
  network_tier: string;
  ens_name: string | null;
  wallet_address: string | null;
  logged_in_at: number;
  logged_out_at: number | null;
  revoked_at: number | null;
  bytes_in: number;
  bytes_out: number;
};

export function useSessions(active = true) {
  return useSWR<{ sessions: ApiSession[]; total: number }>(
    ["sessions", active],
    () => apiGet("sessions", { active: active ? "true" : "false", limit: "200" }),
    { refreshInterval: 10_000 }
  );
}
