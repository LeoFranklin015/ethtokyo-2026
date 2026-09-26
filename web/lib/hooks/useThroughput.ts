"use client";
import useSWR from "swr";
import { apiGet } from "@/lib/api";
import type { Sample } from "@/lib/data";

export function useThroughput() {
  return useSWR<{ samples: Sample[] }>(
    "throughput",
    () => apiGet("bandwidth/timeseries"),
    { refreshInterval: 60_000 }
  );
}
