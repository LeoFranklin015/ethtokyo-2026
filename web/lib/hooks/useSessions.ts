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

/** Scoped to one organization, for the same reason `useUsers` is. */
export function useSessions(org: string | null, active = true) {
  return useSWR<{ sessions: ApiSession[]; total: number }>(
    org ? ["sessions", org, active] : null,
    () =>
      apiGet("sessions", {
        org: org!,
        active: active ? "true" : "false",
        limit: "200",
      }),
    { refreshInterval: 10_000 }
  );
}
