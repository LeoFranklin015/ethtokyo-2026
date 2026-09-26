"use client";
import useSWR from "swr";

type ProxyStatus = {
  status: string;
  ts: number;
  db: string;
  active_sessions: number;
  resources_total: number;
  resources_enabled: number;
};

export function useProxyStatus() {
  return useSWR<ProxyStatus>(
    "proxy-status",
    () => fetch("/api/status").then((r) => r.json()),
    { refreshInterval: 15_000 }
  );
}
