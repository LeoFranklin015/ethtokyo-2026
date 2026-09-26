"use client";

import { PageHeader } from "@/components/console/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { useSessions } from "@/lib/hooks/useSessions";
import { useUsers } from "@/lib/hooks/useUsers";
import { ORG } from "@/lib/config";

export default function BranchesPage() {
  const branchLabel = process.env.NEXT_PUBLIC_BRANCH_LABEL ?? "branch";
  const branchVenue = process.env.NEXT_PUBLIC_BRANCH_VENUE ?? "";
  const branchWindow = process.env.NEXT_PUBLIC_BRANCH_WINDOW ?? "";

  const { data: usersData } = useUsers();
  const { data: sessionsData } = useSessions(true);

  const members = usersData?.total ?? 0;
  const online = sessionsData?.total ?? 0;

  return (
    <>
      <PageHeader eyebrow={ORG.ens} title="Branches" />
      <div className="px-5 py-6 lg:px-8">
        <Panel className="p-5">
          <div className="flex items-baseline justify-between gap-4">
            <div>
              <p className="font-mono text-sm font-medium text-ink">{branchLabel}</p>
              <p className="mt-0.5 font-mono text-[0.6875rem] text-ink-muted">{branchLabel}.{ORG.ens}</p>
              <p className="mt-2 text-sm text-ink-muted">{branchVenue} · {branchWindow}</p>
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-sharp bg-signal/10 px-2 py-1 font-mono text-[0.6875rem] text-signal">
              open
            </span>
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-4 border-t border-rule pt-4 sm:grid-cols-3">
            {[
              { label: "Members", value: members },
              { label: "Online", value: online },
            ].map(({ label, value }) => (
              <div key={label}>
                <dt className="label">{label}</dt>
                <dd className="mt-1 font-mono text-lg tabular-nums text-ink">{value}</dd>
              </div>
            ))}
          </dl>
        </Panel>
      </div>
    </>
  );
}
