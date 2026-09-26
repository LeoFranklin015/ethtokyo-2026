"use client";

import useSWR from "swr";
import { PageHeader } from "@/components/console/PageHeader";
import { GroupForm } from "@/components/console/GroupForm";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { useEnsBranches } from "@/lib/hooks/useEns";
import { ENS, explorer } from "@/lib/ens/config";
import type { RoleInfo } from "@/lib/ens/read";
import { useState } from "react";

/**
 * Groups — the categories people are onboarded into.
 *
 * Read from the branch registrar rather than from config, because a group is on-chain data: an
 * organization can invent one the contract never heard of and it appears here immediately.
 */
export default function GroupsPage() {
  const { branches, isLoading: branchesLoading } = useEnsBranches();
  const withRegistrar = (branches ?? []).filter((b) => b.registrar);
  const [selected, setSelected] = useState<string>("");
  const registrar = selected || withRegistrar[0]?.registrar || "";

  const { data, mutate, isLoading } = useSWR<{ groups: RoleInfo[] }>(
    registrar ? `groups:${registrar}` : null,
    () => fetch(`/api/ens/groups?registrar=${registrar}`).then((r) => r.json()),
  );
  const groups = (data?.groups ?? []).filter((g) => g.active);

  return (
    <>
      <PageHeader
        eyebrow={ENS.organization}
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
                  aria-label="Branch"
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

          {branchesLoading || (registrar && isLoading) ? (
            <p className="px-4 py-10 text-center font-mono text-xs text-ink-muted">reading…</p>
          ) : !registrar ? (
            <div role="status" className="px-4 py-12 text-center">
              <p className="text-sm text-ink">No branch to configure</p>
              <p className="mx-auto mt-1.5 max-w-[42ch] text-sm text-ink-muted">
                Groups belong to a branch. Open one first and it will appear here.
              </p>
            </div>
          ) : groups.length === 0 ? (
            <div role="status" className="px-4 py-12 text-center">
              <p className="text-sm text-ink">No groups yet</p>
              <p className="mx-auto mt-1.5 max-w-[42ch] text-sm text-ink-muted">
                Define one on the right. Until a branch has at least one group, nobody can be
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

        <GroupForm onDone={() => mutate()} />
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
