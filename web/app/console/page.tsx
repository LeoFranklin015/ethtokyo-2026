"use client";

import { useEffect, useState } from "react";
import { PageHeader } from "@/components/console/PageHeader";
import { ThroughputChart } from "@/components/console/ThroughputChart";
import { SignalDither } from "@/components/dither/SignalDither";
import { Meter } from "@/components/ui/Meter";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { useGroups } from "@/lib/hooks/useGroups";
import { useSessions } from "@/lib/hooks/useSessions";
import { useThroughput } from "@/lib/hooks/useThroughput";
import { useUsers } from "@/lib/hooks/useUsers";
import { ENFORCEMENT } from "@/lib/config";

export default function OverviewPage() {
  const { data: groupsData, isLoading: groupsLoading } = useGroups();
  const { data: sessionsData } = useSessions(true);
  const { data: throughputData } = useThroughput();
  const { data: usersData } = useUsers();

  const branchLabel = process.env.NEXT_PUBLIC_BRANCH_LABEL ?? "branch";
  const branchEns = `${branchLabel}.${process.env.NEXT_PUBLIC_ORG_ENS ?? ""}`;
  const branchVenue = process.env.NEXT_PUBLIC_BRANCH_VENUE ?? "";
  const branchWindow = process.env.NEXT_PUBLIC_BRANCH_WINDOW ?? "";

  const groups = groupsData ?? [];
  const sessions = sessionsData?.sessions ?? [];
  const samples = throughputData?.samples ?? [];
  const totalUsers = usersData?.total ?? 0;
  const activeSessions = sessionsData?.total ?? 0;
  const totalDevices = groups.reduce((s, g) => s + g.devices, 0);
  const totalUsed = groups.reduce((s, g) => s + g.used, 0);
  const totalPool = groups.reduce((s, g) => s + g.pool, 0);
  const peak = samples.length ? Math.max(...samples.map(s => s.mbps)) : 0;

  // The five-minute window has to advance on its own, so the clock is state, not a render-time read.
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 10_000);
    return () => clearInterval(t);
  }, []);
  const joined5m = sessions.filter(s => s.logged_in_at >= now - 300).length;
  const { data: recentLeft } = useSessions(false);
  const left5m = (recentLeft?.sessions ?? []).filter(
    s => s.logged_out_at && s.logged_out_at >= now - 300
  ).length;

  const KPIS = [
    { label: "Memberships", value: totalUsers.toLocaleString(), sub: "onboarded here" },
    { label: "Admitted",    value: activeSessions.toLocaleString(), sub: `${totalDevices} devices` },
    { label: "Throughput",  value: totalUsed.toLocaleString(), unit: "Mbps", sub: `peak ${peak.toFixed(0)}` },
    { label: "Denials",     value: "—", sub: "last hour" },
  ];

  const recent = [...sessions]
    .sort((a, b) => b.logged_in_at - a.logged_in_at)
    .slice(0, 5);

  if (groupsLoading) {
    return <div className="px-5 py-12 text-center font-mono text-xs text-ink-muted">Loading…</div>;
  }

  return (
    <>
      <PageHeader
        eyebrow="Branch overview"
        title={branchEns}
        meta={`${branchVenue} · ${branchWindow}`}
        actions={
          <span className="inline-flex items-center gap-2 font-mono text-xs text-ink-muted">
            <span aria-hidden className="size-1.5 rounded-full bg-signal" />
            Live · polling 10s
          </span>
        }
      />

      <dl className="grid grid-cols-2 border-b border-rule sm:grid-cols-4">
        {KPIS.map((kpi, i) => (
          <div
            key={kpi.label}
            className={`px-5 py-4 lg:px-8 ${i < 2 ? "border-b border-rule sm:border-b-0" : ""} ${
              i % 2 === 0 ? "border-r border-rule" : ""
            } sm:border-r sm:last:border-r-0`}
          >
            <dt className="label">{kpi.label}</dt>
            <dd>
              <span className="mt-2.5 flex items-baseline gap-1.5">
                <span className="font-mono text-[1.625rem] font-medium leading-none tabular-nums tracking-tight text-ink">
                  {kpi.value}
                </span>
                {kpi.unit ? <span className="font-mono text-xs text-ink-muted">{kpi.unit}</span> : null}
              </span>
              <span className="mt-1.5 block text-xs text-ink-muted">{kpi.sub}</span>
            </dd>
          </div>
        ))}
      </dl>

      <div className="px-5 py-6 lg:px-8">
        <Panel as="section">
          <PanelHeader right={<span className="font-mono text-[0.6875rem] text-ink-muted">last 6h · 10m samples</span>}>
            Branch throughput
          </PanelHeader>
          <div className="px-2 pb-2 pt-3 sm:px-4">
            <ThroughputChart data={samples} cap={totalPool} />
          </div>
        </Panel>

        <div className="mt-6 grid gap-6 xl:grid-cols-[1.25fr_0.75fr]">
          <Panel as="section">
            <PanelHeader
              right={<span className="font-mono text-[0.6875rem] text-ink-muted">{totalUsed} / {totalPool} Mbps</span>}
            >
              Group utilisation
            </PanelHeader>
            <div className="divide-y divide-rule">
              {groups.map((group) => (
                <Meter
                  key={group.name}
                  label={group.name}
                  used={group.used}
                  cap={group.pool}
                  detail={`vlan ${group.vlan} · ${group.devices} devices`}
                />
              ))}
            </div>
          </Panel>

          <div className="flex flex-col gap-6">
            <Panel as="section">
              <PanelHeader>Perimeter</PanelHeader>
              <div className="flex items-stretch divide-x divide-rule">
                <div className="relative w-[104px] shrink-0">
                  <SignalDither motif="radar" cell={2} period={4.5} intensity={0.75} className="absolute inset-0" label="Radar sweep" />
                </div>
                <dl className="flex-1 divide-y divide-rule">
                  {[
                    ["Present", String(activeSessions)],
                    ["Joined 5m", String(joined5m)],
                    ["Left 5m",   String(left5m)],
                  ].map(([term, value]) => (
                    <div key={term} className="flex items-baseline justify-between gap-3 px-4 py-[0.6875rem]">
                      <dt className="label">{term}</dt>
                      <dd className="font-mono text-xs tabular-nums text-ink-80">{value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </Panel>

            <Panel as="section">
              <PanelHeader>Recent admissions</PanelHeader>
              <ul className="divide-y divide-rule">
                {recent.map((s) => {
                  const label = s.ens_name?.split(".")[0] ?? s.username;
                  const time = new Date(s.logged_in_at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                  return (
                    <li key={s.id} className="flex items-baseline justify-between gap-3 px-4 py-2.5">
                      <span className="truncate font-mono text-xs text-ink">
                        {label}<span className="text-ink-muted">.{branchLabel}</span>
                      </span>
                      <span className="shrink-0 font-mono text-xs tabular-nums text-ink-muted">{time}</span>
                    </li>
                  );
                })}
              </ul>
            </Panel>
          </div>
        </div>

        <Panel as="section" className="mt-6">
          <PanelHeader>Enforcement</PanelHeader>
          <dl className="grid sm:grid-cols-2 xl:grid-cols-3">
            {ENFORCEMENT.map(([term, detail]) => (
              <div key={term} className="flex items-baseline justify-between gap-4 border-b border-rule px-4 py-2.5 sm:border-r sm:last:border-r-0">
                <dt className="label">{term}</dt>
                <dd className="text-right font-mono text-xs text-ink-80">{detail}</dd>
              </div>
            ))}
          </dl>
        </Panel>
      </div>
    </>
  );
}
