"use client";
import useSWR from "swr";
import { apiGet } from "@/lib/api";
import type { Sample } from "@/lib/data";

/**
 * The 10-minute throughput buckets behind the overview chart.
 *
 * `org` is required and the fetch is skipped without one. Traffic is attributed through the
 * session's account back to the ENS name, because a usage event carries no name of its own;
 * asking unscoped plots the whole deployment, which put another organization's bytes on a
 * chart labelled with yours.
 */
export function useThroughput(org: string | null) {
  return useSWR<{ samples: Sample[] }>(
    org ? ["throughput", org] : null,
    () => apiGet("bandwidth/timeseries", { org: org! }),
    { refreshInterval: 60_000 }
  );
}
