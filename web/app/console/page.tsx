import { PageHeader } from "@/components/console/PageHeader";
import { ThroughputChart } from "@/components/console/ThroughputChart";
import { SignalDither } from "@/components/dither/SignalDither";
import { Meter } from "@/components/ui/Meter";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { SourceTag } from "@/components/ui/SourceTag";
import { GROUPS, THROUGHPUT } from "@/lib/data";
import { getBranch, getMemberships } from "@/lib/ens/branch";
import { explorer } from "@/lib/ens/config";

export const metadata = { title: "Overview — ENSCA console" };
export const revalidate = 30;

const totalUsed = GROUPS.reduce((sum, g) => sum + g.used, 0);
const totalPool = GROUPS.reduce((sum, g) => sum + g.pool, 0);
const peak = Math.max(...THROUGHPUT.map((s) => s.mbps));

function formatWindow(expiry: number): string {
  const days = Math.max(0, Math.round((expiry * 1000 - Date.now()) / 86_400_000));
  return `${days} days left`;
}

export default async function OverviewPage() {
  const [branch, memberships] = await Promise.all([getBranch(), getMemberships()]);

  const online = memberships.length;
  const kpis = [
    { label: "Memberships", value: String(memberships.length), sub: "in the branch registry", source: "chain" as const },
    { label: "Admitted", value: String(online), sub: "holding a live name", source: "chain" as const },
    { label: "Throughput", value: totalUsed.toLocaleString(), unit: "Mbps", sub: `peak ${peak}`, source: "enforcer" as const },
    { label: "Groups", value: String(GROUPS.length), sub: "isolated VLANs", source: "enforcer" as const },
  ];

  return (
    <>
      <PageHeader
        eyebrow={`${branch.organization} · branch`}
        title={branch.branch}
        meta={`${branch.venue} · ${formatWindow(branch.expiry)}`}
        actions={
          <span className="inline-flex items-center gap-2 font-mono text-xs text-ink-muted">
            <span
              aria-hidden
              className="size-1.5 rounded-full"
              style={{ background: branch.open ? "var(--signal)" : "var(--alert)" }}
            />
            {branch.open ? "Branch open" : "Branch closed"}
          </span>
        }
      />

      <dl className="grid grid-cols-2 border-b border-rule sm:grid-cols-4">
        {kpis.map((kpi, i) => (
          <div
            key={kpi.label}
            className={`px-5 py-4 lg:px-8 ${i < 2 ? "border-b border-rule sm:border-b-0" : ""} ${
              i % 2 === 0 ? "border-r border-rule" : ""
            } sm:border-r sm:last:border-r-0`}
          >
            <dt className="flex items-center justify-between gap-2">
              <span className="label">{kpi.label}</span>
              <SourceTag source={kpi.source} />
            </dt>
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
          <PanelHeader right={<SourceTag source="enforcer" />}>Branch throughput</PanelHeader>
          <div className="px-2 pb-2 pt-3 sm:px-4">
            <ThroughputChart data={THROUGHPUT} cap={totalPool} />
          </div>
        </Panel>

        <div className="mt-6 grid gap-6 xl:grid-cols-[1.25fr_0.75fr]">
          <Panel as="section">
            <PanelHeader right={<SourceTag source="enforcer" />}>Group utilisation</PanelHeader>
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
              <PanelHeader right={<SourceTag source="chain" />}>Registry</PanelHeader>
              <dl className="divide-y divide-rule">
                {[
                  ["Organization", branch.organization, ""],
                  ["Branch registry", `${branch.registry.slice(0, 10)}…`, branch.registry],
                  ["Registrar", `${branch.registrar.slice(0, 10)}…`, branch.registrar],
                  ["Resolver", `${branch.resolver.slice(0, 10)}…`, branch.resolver],
                  ["Emancipated", branch.emancipated ? "yes" : "no — org retains control", ""],
                ].map(([term, detail, href]) => (
                  <div key={term} className="flex items-baseline justify-between gap-4 px-4 py-2.5">
                    <dt className="label">{term}</dt>
                    <dd className="text-right font-mono text-xs text-ink-80">
                      {href ? (
                        <a
                          href={explorer(href)}
                          target="_blank"
                          rel="noreferrer"
                          className="underline decoration-rule underline-offset-2 hover:text-ink"
                        >
                          {detail}
                        </a>
                      ) : (
                        detail
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </Panel>

            <Panel as="section">
              <PanelHeader right={<SourceTag source="enforcer" />}>Perimeter</PanelHeader>
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
                    ["Present", String(online)],
                    ["Joined 5m", "0"],
                    ["Left 5m", "0"],
                  ].map(([term, value]) => (
                    <div key={term} className="flex items-baseline justify-between gap-3 px-4 py-[0.6875rem]">
                      <dt className="label">{term}</dt>
                      <dd className="font-mono text-xs tabular-nums text-ink-80">{value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </Panel>
          </div>
        </div>
      </div>
    </>
  );
}
