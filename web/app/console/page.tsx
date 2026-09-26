import { PageHeader } from "@/components/console/PageHeader";
import { SignalDither } from "@/components/dither/SignalDither";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { SourceTag } from "@/components/ui/SourceTag";
import { Unavailable } from "@/components/ui/Unavailable";
import { getBranch, getMemberships } from "@/lib/ens/branch";
import { explorer } from "@/lib/ens/config";
import {
  bytesByGroup,
  enforcerConfigured,
  formatBytes,
  getSessions,
  getStatus,
} from "@/lib/enforcer/client";

export const metadata = { title: "Overview — ENSCA console" };
export const revalidate = 15;

function formatWindow(expiry: number): string {
  const days = Math.max(0, Math.round((expiry * 1000 - Date.now()) / 86_400_000));
  return `${days} days left`;
}

const ENFORCER_HINT =
  "Set ENFORCER_URL and ENFORCER_TOKEN to the branch enforcer's admin API. Until then this panel stays empty rather than showing a number nobody measured.";

export default async function OverviewPage() {
  const [branch, memberships, status, sessions] = await Promise.all([
    getBranch(),
    getMemberships(),
    getStatus(),
    getSessions(),
  ]);

  const groups = sessions ? bytesByGroup(sessions) : null;
  const totalBytes = sessions
    ? sessions.reduce((sum, s) => sum + s.bytes_in + s.bytes_out, 0)
    : null;

  const kpis = [
    {
      label: "Memberships",
      value: String(memberships.length),
      sub: "in the branch registry",
      source: "chain" as const,
    },
    {
      label: "Active sessions",
      value: status ? String(status.active_sessions) : null,
      sub: "devices admitted now",
      source: "enforcer" as const,
    },
    {
      label: "Traffic",
      value: totalBytes === null ? null : formatBytes(totalBytes),
      sub: "across live sessions",
      source: "enforcer" as const,
    },
    {
      label: "Groups",
      value: groups ? String(groups.length) : null,
      sub: "carrying live traffic",
      source: "enforcer" as const,
    },
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
              <span className="mt-2.5 block font-mono text-[1.625rem] font-medium leading-none tabular-nums tracking-tight text-ink">
                {kpi.value ?? <span className="text-ink-faint">—</span>}
              </span>
              <span className="mt-1.5 block text-xs text-ink-muted">
                {kpi.value === null ? "enforcer unreachable" : kpi.sub}
              </span>
            </dd>
          </div>
        ))}
      </dl>

      <div className="grid gap-6 px-5 py-6 lg:px-8 xl:grid-cols-[1.25fr_0.75fr]">
        <Panel as="section">
          <PanelHeader
            right={
              groups ? (
                <span className="font-mono text-[0.6875rem] text-ink-muted">
                  {sessions?.length ?? 0} live sessions
                </span>
              ) : (
                <SourceTag source="enforcer" />
              )
            }
          >
            Traffic by group
          </PanelHeader>

          {groups === null ? (
            <Unavailable
              what={enforcerConfigured() ? "Enforcer unreachable" : "Enforcer not configured"}
              hint={ENFORCER_HINT}
            />
          ) : groups.length === 0 ? (
            <Unavailable
              what="No live sessions"
              hint="Nobody is currently admitted to the branch network."
            />
          ) : (
            <ul className="divide-y divide-rule">
              {groups.map((g) => (
                <li key={g.name} className="flex items-baseline justify-between gap-4 px-4 py-3">
                  <span className="font-mono text-xs text-ink">{g.name}</span>
                  <span className="flex items-baseline gap-4 font-mono text-xs tabular-nums text-ink-muted">
                    <span>{g.devices} devices</span>
                    <span className="text-ink-80">
                      ↓ {formatBytes(g.bytesIn)} · ↑ {formatBytes(g.bytesOut)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
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
                  label="Radar sweep indicating presence detection"
                />
              </div>
              <dl className="flex-1 divide-y divide-rule">
                {[
                  ["Present", status ? String(status.active_sessions) : null],
                  ["Resources", status ? String(status.resources_enabled) : null],
                  ["Database", status?.db ?? null],
                ].map(([term, value]) => (
                  <div
                    key={term}
                    className="flex items-baseline justify-between gap-3 px-4 py-[0.6875rem]"
                  >
                    <dt className="label">{term}</dt>
                    <dd className="font-mono text-xs tabular-nums text-ink-80">
                      {value ?? <span className="text-ink-faint">—</span>}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          </Panel>
        </div>
      </div>
    </>
  );
}
