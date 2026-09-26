"use client";

import { useEffect, useState } from "react";
import { PageHeader } from "@/components/console/PageHeader";
import { ThroughputChart } from "@/components/console/ThroughputChart";
import { SignalDither } from "@/components/dither/SignalDither";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { useGroups } from "@/lib/hooks/useGroups";
import { useSessions } from "@/lib/hooks/useSessions";
import { useThroughput } from "@/lib/hooks/useThroughput";
import { useUsers } from "@/lib/hooks/useUsers";
import { useEnsBranches } from "@/lib/hooks/useEns";

/**
 * The branch overview.
 *
 * Everything here is measured. An earlier version showed an invented VLAN and bandwidth pool per
 * tier, a "throughput" computed by dividing a cumulative byte counter by an assumed 60-second
 * window, a hardcoded denial count, and a fabricated cache age — and rendered all of it as zeros
 * under a green "Live" dot whenever the enforcer was unreachable. A failed read now says so.
 */
export default function OverviewPage() {
  const groups = useGroups();
  const active = useSessions(true);
  const ended = useSessions(false);
  const throughput = useThroughput();
  const users = useUsers();
  const { branches } = useEnsBranches();

  // One enforcer serves one branch, so the branch is configuration. Picking `branches[0]`
  // instead meant the alphabetically-first branch's name sat above figures that are
  // enforcer-wide — a real number under a label that did not describe it.
  const configured = process.env.NEXT_PUBLIC_BRANCH_ENS?.trim();
  const branchEns = configured || null;
  const branchCount = branches?.length ?? null;

  // The five-minute window has to advance on its own, so the clock is state, not a render read.
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 10_000);
    return () => clearInterval(t);
  }, []);

  const enforcerDown = groups.error ?? active.error ?? users.error;
  const loading = groups.isLoading || active.isLoading || users.isLoading;

  const sessions = active.data?.sessions ?? [];
  const samples = throughput.data?.samples ?? [];
  const joined5m = sessions.filter((s) => s.logged_in_at >= now - 300).length;
  const left5m = (ended.data?.sessions ?? []).filter(
    (s) => s.logged_out_at && s.logged_out_at >= now - 300,
  ).length;

  const recent = [...sessions].sort((a, b) => b.logged_in_at - a.logged_in_at).slice(0, 5);

  return (
    <>
      <PageHeader
        eyebrow="Branch overview"
        title={branchEns ?? "This enforcer"}
        meta={
          branchEns
            ? "Live from ENS and the branch enforcer"
            : branchCount !== null
              ? `Set NEXT_PUBLIC_BRANCH_ENS to name this branch — ${branchCount} exist in ENS`
              : undefined
        }
        actions={<Freshness down={Boolean(enforcerDown)} loading={loading} />}
      />

      <div className="px-4 pb-16 pt-6 sm:px-6">
        {enforcerDown ? (
          <Panel as="section" className="mb-6">
            <div className="px-4 py-5">
              <p className="text-sm" style={{ color: "var(--alert)" }}>
                The branch enforcer did not answer.
              </p>
              <p className="mt-1 max-w-[60ch] text-xs leading-relaxed text-ink-muted">
                Session and membership figures are not shown rather than shown as zero — an
                unreachable enforcer is not an empty branch. Anything sourced from ENS below is
                unaffected.
              </p>
            </div>
          </Panel>
        ) : null}

        <div className="grid gap-px overflow-hidden rounded-sharp border border-rule bg-rule sm:grid-cols-3">
          <Kpi
            label="Memberships"
            value={users.data?.total}
            sub="known to this enforcer"
            failed={Boolean(users.error)}
            loading={users.isLoading}
          />
          <Kpi
            label="Admitted now"
            value={active.data?.total}
            sub="open sessions"
            failed={Boolean(active.error)}
            loading={active.isLoading}
          />
          <Kpi
            label="Groups"
            value={groups.data?.length}
            sub="defined on this enforcer"
            failed={Boolean(groups.error)}
            loading={groups.isLoading}
          />
        </div>

        {throughput.error ? (
          <Panel as="section" className="mt-6">
            <PanelHeader>API proxy throughput</PanelHeader>
            <Failed what="throughput series" />
          </Panel>
        ) : samples.length >= 2 ? (
          <Panel as="section" className="mt-6">
            <PanelHeader
              right={
                <span className="font-mono text-[0.6875rem] text-ink-muted">
                  last 6h · 10m buckets
                </span>
              }
            >
              API proxy throughput
            </PanelHeader>
            <div className="px-2 pb-2 pt-3 sm:px-4">
              {/* Named for what it measures: bytes the enforcer proxied to clients, not wifi. */}
              <ThroughputChart data={samples} />
            </div>
          </Panel>
        ) : null}

        <div className="mt-6 grid gap-6 xl:grid-cols-[1.25fr_0.75fr]">
          <Panel as="section">
            <PanelHeader>Groups on the enforcer</PanelHeader>
            {groups.error ? (
              <Failed what="group list" />
            ) : groups.isLoading ? (
              <Waiting />
            ) : (groups.data ?? []).length === 0 ? (
              <Empty>
                The enforcer has no groups yet. A group defined in ENS admits nobody until it also
                exists here.
              </Empty>
            ) : (
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-rule">
                    <th className="label px-4 py-2 font-normal">Group</th>
                    <th className="label px-4 py-2 font-normal">Tier</th>
                    <th className="label px-4 py-2 text-right font-normal">Members</th>
                    <th className="label px-4 py-2 text-right font-normal">Admitted</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-rule">
                  {(groups.data ?? []).map((g) => (
                    <tr key={g.id}>
                      <td className="px-4 py-2.5 font-mono text-xs text-ink">{g.name}</td>
                      <td className="px-4 py-2.5 font-mono text-xs text-ink-muted">
                        {g.network_tier}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-xs tabular-nums text-ink-80">
                        {g.member_count}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-xs tabular-nums text-ink-80">
                        {g.active_session_count}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>

          <div className="flex flex-col gap-6">
            <Panel as="section">
              <PanelHeader>Perimeter</PanelHeader>
              <div className="flex items-stretch divide-x divide-rule">
                <div className="relative w-[104px] shrink-0">
                  <SignalDither
                    motif="radar"
                    cell={2}
                    period={4.5}
                    intensity={0.75}
                    className="absolute inset-0"
                    label="Radar sweep"
                  />
                </div>
                <dl className="flex-1 divide-y divide-rule">
                  <Row term="Present" value={active.error ? null : (active.data?.total ?? null)} />
                  <Row term="Joined 5m" value={active.error ? null : joined5m} />
                  <Row term="Left 5m" value={ended.error ? null : left5m} />
                </dl>
              </div>
            </Panel>

            <Panel as="section">
              <PanelHeader>Recent admissions</PanelHeader>
              {active.error ? (
                <Failed what="session list" />
              ) : active.isLoading ? (
                <Waiting />
              ) : recent.length === 0 ? (
                <Empty>Nobody has been admitted yet.</Empty>
              ) : (
                <ul className="divide-y divide-rule">
                  {recent.map((s) => (
                    <li key={s.id} className="flex items-baseline justify-between gap-3 px-4 py-2.5">
                      <span className="truncate font-mono text-xs text-ink">
                        {s.ens_name ?? s.username}
                      </span>
                      <span className="shrink-0 font-mono text-xs tabular-nums text-ink-muted">
                        {new Date(s.logged_in_at * 1000).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        </div>
      </div>
    </>
  );
}

function Row({ term, value }: { term: string; value: number | null }) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-4 py-[0.6875rem]">
      <dt className="label">{term}</dt>
      <dd className="font-mono text-xs tabular-nums text-ink-80">
        {value === null ? <span className="text-ink-faint">unavailable</span> : String(value)}
      </dd>
    </div>
  );
}

function Kpi({
  label,
  value,
  sub,
  failed,
  loading,
}: {
  label: string;
  value: number | undefined;
  sub: string;
  failed: boolean;
  loading: boolean;
}) {
  return (
    <div className="bg-paper px-4 py-5">
      <span className="label">{label}</span>
      <span className="mt-2 block font-mono text-2xl tabular-nums text-ink">
        {failed ? (
          <span className="text-base" style={{ color: "var(--alert)" }}>
            unavailable
          </span>
        ) : loading || value === undefined ? (
          <span className="text-base text-ink-faint">…</span>
        ) : (
          value.toLocaleString()
        )}
      </span>
      <span className="mt-1 block text-xs text-ink-muted">
        {failed ? "the enforcer did not answer" : sub}
      </span>
    </div>
  );
}

/** Honest about what it knows: green only when the last read actually succeeded. */
function Freshness({ down, loading }: { down: boolean; loading: boolean }) {
  const colour = down ? "var(--alert)" : loading ? "var(--ink-faint)" : "var(--signal)";
  return (
    <span className="inline-flex items-center gap-2 font-mono text-xs text-ink-muted">
      <span aria-hidden className="size-1.5 rounded-full" style={{ background: colour }} />
      {down ? "Enforcer unreachable" : loading ? "Reading…" : "Auto-refresh · 10–60s"}
    </span>
  );
}

function Failed({ what }: { what: string }) {
  return (
    <p className="px-4 py-6 text-xs leading-relaxed" style={{ color: "var(--alert)" }} role="status">
      The {what} could not be read. No figure is shown rather than a stale one.
    </p>
  );
}

function Waiting() {
  return <p className="px-4 py-6 font-mono text-xs text-ink-muted">Reading…</p>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-6 text-xs leading-relaxed text-ink-muted">{children}</p>;
}
