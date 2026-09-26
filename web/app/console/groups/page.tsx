"use client";

import useSWR from "swr";
import { PageHeader } from "@/components/console/PageHeader";
import { NoOrgSelected } from "@/components/console/OrgPicker";
import { useOrg } from "@/lib/hooks/useOrg";
import { GroupForm } from "@/components/console/GroupForm";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { useEnsBranches } from "@/lib/hooks/useEns";
import { explorer } from "@/lib/ens/config";
import type { RoleInfo } from "@/lib/ens/read";
import { useState } from "react";

/**
 * Groups — the categories people are onboarded into.
 *
 * Read from the branch registrar rather than from config, because a group is on-chain data: an
 * organization can invent one the contract never heard of and it appears here immediately.
 */
export default function GroupsPage() {
  const org = useOrg();
  const { branches, isLoading: branchesLoading } = useEnsBranches(org);
  const withRegistrar = (branches ?? []).filter((b) => b.registrar);
  const [selected, setSelected] = useState<string>("");
  const registrar = selected || withRegistrar[0]?.registrar || "";

  const { data, mutate, isLoading, error } = useSWR<{ groups: RoleInfo[] }>(
    registrar ? `groups:${registrar}` : null,
    async () => {
      const r = await fetch(`/api/ens/groups?registrar=${registrar}`);
      if (!r.ok) throw new Error(`group catalogue unavailable (${r.status})`);
      return r.json();
    },
  );
  const groups = (data?.groups ?? []).filter((g) => g.active);

  // Every figure below belongs to one organization. Without one there is nothing to read,
  // and guessing which is how this console used to answer with somebody else's data.
  if (!org) return <NoOrgSelected />;

  return (
    <>
      <PageHeader
        eyebrow={`${org}.eth`}
        title="Groups"
        meta="Categories of people. A group mints no name — onboarding assigns one."
      />

      <div className="grid gap-6 px-5 py-6 lg:px-8 xl:grid-cols-[1fr_minmax(0,420px)]">
        <Panel as="section" className="overflow-hidden">
          <PanelHeader
            right={
              withRegistrar.length > 1 ? (
                <select
                  value={registrar}
                  onChange={(e) => setSelected(e.target.value)}
                  aria-label="Perimeter"
                  className="h-7 rounded-sharp border border-rule bg-paper px-1.5 font-mono text-[0.6875rem] text-ink"
                >
                  {withRegistrar.map((b) => (
                    <option key={b.label} value={b.registrar ?? ""}>
                      {b.label}
                    </option>
                  ))}
                </select>
              ) : registrar ? (
                <a
                  href={explorer(registrar)}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-[0.6875rem] text-ink-muted underline decoration-rule underline-offset-2 hover:text-ink"
                >
                  registrar
                </a>
              ) : null
            }
          >
            Defined on-chain
          </PanelHeader>

          {error ? (
            <p
              className="px-4 py-10 text-center text-xs leading-relaxed"
              style={{ color: "var(--alert)" }}
              role="status"
            >
              The group catalogue could not be read from the chain. It is not shown rather than
              shown empty.
            </p>
          ) : branchesLoading || (registrar && isLoading) ? (
            <p className="px-4 py-10 text-center font-mono text-xs text-ink-muted">reading…</p>
          ) : !registrar ? (
            <div role="status" className="px-4 py-12 text-center">
              <p className="text-sm text-ink">No perimeter to configure</p>
              <p className="mx-auto mt-1.5 max-w-[42ch] text-sm text-ink-muted">
                Groups belong to a perimeter. Open one first and it will appear here.
              </p>
            </div>
          ) : groups.length === 0 ? (
            <div role="status" className="px-4 py-12 text-center">
              <p className="text-sm text-ink">No groups yet</p>
              <p className="mx-auto mt-1.5 max-w-[42ch] text-sm text-ink-muted">
                Define one on the right. Until a perimeter has at least one group, nobody can be
                onboarded into it.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-rule">
              {groups.map((g) => (
                <li key={g.id} className="px-4 py-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-3">
                    <span className="font-mono text-sm text-ink">{g.name}</span>
                    <span className="flex gap-2 font-mono text-[0.6875rem] text-ink-muted">
                      {g.openToOnboarders ? <Tag>open to onboarders</Tag> : <Tag>restricted</Tag>}
                      {g.canOnboard ? <Tag>may onboard</Tag> : null}
                    </span>
                  </div>
                  {g.entitlements.length ? (
                    <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                      {g.entitlements.map((e) => (
                        <div key={e.key} className="flex items-baseline gap-1.5">
                          <dt className="font-mono text-[0.6875rem] text-ink-muted">{e.key}</dt>
                          <dd className="font-mono text-[0.6875rem] text-ink-80">{e.value}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : (
                    <p className="mt-2 text-xs text-ink-muted">Publishes no entitlements.</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <GroupForm org={org} onDone={() => mutate()} />
      </div>
    </>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-rule px-2 py-0.5 uppercase tracking-[0.1em]">
      {children}
    </span>
  );
}
