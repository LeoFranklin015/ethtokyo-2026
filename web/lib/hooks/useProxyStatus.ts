"use client";
import useSWR from "swr";

type ProxyStatus = {
  status: string;
  ts: number;
};

export function useProxyStatus() {
  return useSWR<ProxyStatus>(
    "proxy-status",
    () => fetch("/api/status").then(async (r) => {
      if (!r.ok) throw new Error(`enforcer status ${r.status}`);
      return r.json();
    }),
    { refreshInterval: 15_000 }
  );
}
