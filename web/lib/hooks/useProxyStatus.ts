"use client";
import useSWR from "swr";

type ProxyStatus = {
  status: string;
  ts: number;
};

export function useProxyStatus() {
  return useSWR<ProxyStatus>(
    "proxy-status",
    () => fetch("/api/status").then((r) => r.json()),
    { refreshInterval: 15_000 }
  );
}
