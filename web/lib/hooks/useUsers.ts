"use client";
import useSWR from "swr";
import { apiGet } from "@/lib/api";

export type ApiUser = {
  id: string;
  username: string;
  default_group_id: string | null;
  ens_name: string | null;
  wallet_address: string | null;
  created_at: number;
  disabled: number;
};

export function useUsers(params?: {
  group_id?: string;
  disabled?: "0" | "1";
  limit?: string;
}) {
  const key = ["users", JSON.stringify(params ?? {})];
  return useSWR<{ users: ApiUser[]; total: number }>(
    key,
    () => apiGet("users", { limit: "200", ...params } as Record<string, string>),
    { refreshInterval: 30_000 }
  );
}
