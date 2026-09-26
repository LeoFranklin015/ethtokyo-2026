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

/**
 * The organization's people, as the enforcer has them.
 *
 * `org` is required and the fetch is skipped without one. The enforcer keeps no organization
 * column — one deployment can hold several organizations' members — so it matches on the ENS
 * name's suffix. Asking unscoped returns the whole deployment, which is how this list came to
 * show another organization's members under the name of the one you had opened.
 */
export function useUsers(
  org: string | null,
  params?: {
    group_id?: string;
    disabled?: "0" | "1";
    limit?: string;
  },
) {
  const key = org ? ["users", org, JSON.stringify(params ?? {})] : null;
  return useSWR<{ users: ApiUser[]; total: number }>(
    key,
    () => apiGet("users", { org: org!, limit: "200", ...params } as Record<string, string>),
    { refreshInterval: 30_000 }
  );
}
