"use client";

import { useEffect } from "react";
import { useSearchParams } from "next/navigation";
import useSWR from "swr";
import { useAccount } from "wagmi";
import { recentOrgs, rememberOrg } from "@/lib/ens/recentOrgs";

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
  const raw = params.get("org")?.trim().toLowerCase();
  const org = raw && /^[a-z0-9-]{1,32}$/.test(raw) ? raw : null;

  // Opening one is what makes it worth remembering. The picker re-checks the registry before
  // listing it, so recording it here cannot put anything in the list that is not really there.
  useEffect(() => {
    if (org) rememberOrg(org);
  }, [org]);

  return org;
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

  // Organizations this browser has been in, checked against the registry.
  //
  // The list above is only as complete as the ENS indexer, which has been both behind and
  // stopped — and an organization set up since its last indexed block is missing from it
  // entirely. Reading the few labels this browser remembers costs one call each and means the
  // thing you just created is in the list, not merely reachable if you know to type its name.
  const { data: remembered } = useSWR<OwnedOrg[]>(
    address ? `recent-orgs:${address}` : null,
    async () => {
      const labels = recentOrgs();
      if (labels.length === 0) return [];
      const checked = await Promise.all(
        labels.map(async (label) => {
          try {
            const res = await fetch(`/api/ens/org?name=${encodeURIComponent(label)}`, {
              cache: "no-store",
            });
            if (!res.ok) return null;
            const body = (await res.json()) as {
              name: string;
              owner: string | null;
              organization: { branchFactory: string } | null;
            };
            // Only if it is set up and still theirs. A name that changed hands must not keep
            // showing up here because this browser once visited it.
            if (!body.organization) return null;
            if (body.owner?.toLowerCase() !== address!.toLowerCase()) return null;
            return {
              label,
              name: body.name,
              expiry: null,
              ready: true,
              branchFactory: body.organization.branchFactory,
            } as OwnedOrg;
          } catch {
            return null;
          }
        }),
      );
      return checked.filter((o): o is OwnedOrg => o !== null);
    },
    { refreshInterval: 60_000 },
  );

  // The indexer's row wins where both have it: same identity, and it carries the expiry.
  const merged = data?.organizations
    ? [
        ...data.organizations,
        ...(remembered ?? []).filter(
          (r) => !data.organizations.some((o) => o.label === r.label),
        ),
      ]
    : remembered?.length
      ? remembered
      : undefined;

  return { organizations: merged, error, isLoading, reload: mutate };
}

/** Preserve the selected organization across console links. */
export function withOrg(href: string, org: string | null): string {
  return org ? `${href}?org=${org}` : href;
}
