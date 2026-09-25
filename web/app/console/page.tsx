import { PageHeader } from "@/components/console/PageHeader";
import { ThroughputChart } from "@/components/console/ThroughputChart";
import { SignalDither } from "@/components/dither/SignalDither";
import { Meter } from "@/components/ui/Meter";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { BRANCHES, GROUPS, MEMBERSHIPS, THROUGHPUT } from "@/lib/data";

export const metadata = { title: "Overview — ENSCA console" };

const branch = BRANCHES[0];
const totalUsed = GROUPS.reduce((sum, g) => sum + g.used, 0);
const totalPool = GROUPS.reduce((sum, g) => sum + g.pool, 0);
const devices = GROUPS.reduce((sum, g) => sum + g.devices, 0);
const peak = Math.max(...THROUGHPUT.map((s) => s.mbps));

const KPIS = [
  { label: "Memberships", value: branch.members.toLocaleString(), sub: "onboarded here" },
  { label: "Admitted", value: branch.online.toLocaleString(), sub: `${devices} devices` },
  { label: "Throughput", value: totalUsed.toLocaleString(), unit: "Mbps", sub: `peak ${peak}` },
  { label: "Denials", value: "3", sub: "last hour" },
];

const ENFORCEMENT = [
  ["Resource", "wifi"],
  ["Enforcer", "fedora-vm · enp10s0u1"],
  ["Identity", "DHCP lease → Membership"],
  ["Resolution", "Membership → Member → deny"],
  ["Revocation", "applied on next check"],
  ["Record cache", "12s old · ttl 60s"],
];

const recent = MEMBERSHIPS.filter((m) => m.online).slice(0, 5);

export default function OverviewPage() {
  return (
    <>
      <PageHeader
        eyebrow="Branch overview"
        title={branch.ens}
        meta={`${branch.venue} · ${branch.window}`}
        actions={
          <span className="inline-flex items-center gap-2 font-mono text-xs text-ink-muted">
            <span aria-hidden className="size-1.5 rounded-full bg-signal" />
            Live · updated 12s ago
          </span>
        }
      />

      {/* Instrument strip — page chrome, not another card */}
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
                {kpi.unit ? (
                  <span className="font-mono text-xs text-ink-muted">{kpi.unit}</span>
                ) : null}
              </span>
              <span className="mt-1.5 block text-xs text-ink-muted">{kpi.sub}</span>
            </dd>
          </div>
        ))}
      </dl>

      <div className="px-5 py-6 lg:px-8">
        {/* The page's focal point: the only view with a time axis */}
        <Panel as="section">
          <PanelHeader
            right={
              <span className="font-mono text-[0.6875rem] text-ink-muted">
                last 6h · 10m samples
              </span>
            }
          >
            Branch throughput
          </PanelHeader>
          <div className="px-2 pb-2 pt-3 sm:px-4">
            <ThroughputChart data={THROUGHPUT} cap={totalPool} />
          </div>
        </Panel>

        <div className="mt-6 grid gap-6 xl:grid-cols-[1.25fr_0.75fr]">
          <Panel as="section">
            <PanelHeader
              right={
                <span className="font-mono text-[0.6875rem] text-ink-muted">
                  {totalUsed.toLocaleString()} / {totalPool.toLocaleString()} Mbps
                </span>
              }
            >
              Group utilisation
            </PanelHeader>
            <div className="divide-y divide-rule">
              {GROUPS.map((group) => (
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
                  <SignalDither
                    motif="radar"
                    cell={2}
                    period={4.5}
                    intensity={0.75}
                    className="absolute inset-0"
                    label="Radar sweep indicating live presence detection"
                  />
                </div>
                <dl className="flex-1 divide-y divide-rule">
                  {[
                    ["Present", String(branch.online)],
                    ["Joined 5m", "14"],
                    ["Left 5m", "9"],
                  ].map(([term, value]) => (
                    <div
                      key={term}
                      className="flex items-baseline justify-between gap-3 px-4 py-[0.6875rem]"
                    >
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
                {recent.map((m) => (
                  <li
                    key={m.label}
                    className="flex items-baseline justify-between gap-3 px-4 py-2.5"
                  >
                    <span className="truncate font-mono text-xs text-ink">
                      {m.label}
                      <span className="text-ink-muted">.{branch.label}</span>
                    </span>
                    <span className="shrink-0 font-mono text-xs tabular-nums text-ink-muted">
                      {m.onboarded}
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          </div>
        </div>

        <Panel as="section" className="mt-6">
          <PanelHeader>Enforcement</PanelHeader>
          <dl className="grid sm:grid-cols-2 xl:grid-cols-3">
            {ENFORCEMENT.map(([term, detail]) => (
              <div
                key={term}
                className="flex items-baseline justify-between gap-4 border-b border-rule px-4 py-2.5 sm:border-r sm:last:border-r-0"
              >
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
