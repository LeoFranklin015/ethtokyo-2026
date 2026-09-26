"use client";

import { useSearchParams } from "next/navigation";
import useSWR from "swr";
import { useAccount } from "wagmi";

/**
 * Which organization is this console looking at?
 *
 * Taken from `?org=` in the URL rather than configuration, because a console serves whoever is
 * signed in and they may run more than one. It used to be a constant — `ethglobal2.eth` — which
 * meant every branch list, group catalogue and membership table answered for that one name no
 * matter whose organization you had just created.
 *
 * `null` is a legitimate state: nothing is selected yet, and the console shows the picker.
 */
export function useOrg(): string | null {
  const params = useSearchParams();
  const org = params.get("org")?.trim().toLowerCase();
  return org && /^[a-z0-9-]{1,32}$/.test(org) ? org : null;
}

export type OwnedOrg = {
  label: string;
  name: string;
  expiry: number | null;
  /** `null` means the check itself failed — not that it is unset up. */
  ready: boolean | null;
  branchFactory: string | null;
};

/** Every `.eth` name this wallet holds, and whether each is set up as an organization. */
export function useOwnedOrgs() {
  const { address } = useAccount();
  const { data, error, isLoading, mutate } = useSWR<{ organizations: OwnedOrg[] }>(
    address ? `orgs:${address}` : null,
    async () => {
      const res = await fetch(`/api/ens/orgs?owner=${address}`);
      if (!res.ok) throw new Error("could not list your names");
      return res.json();
    },
    { refreshInterval: 60_000 },
  );

  return { organizations: data?.organizations, error, isLoading, reload: mutate };
}

/** Preserve the selected organization across console links. */
export function withOrg(href: string, org: string | null): string {
  return org ? `${href}?org=${org}` : href;
}
