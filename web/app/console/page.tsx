import { PageHeader } from "@/components/console/PageHeader";
import { SignalDither } from "@/components/dither/SignalDither";
import { Meter } from "@/components/ui/Meter";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Stat } from "@/components/ui/Stat";
import { BRANCHES, GROUPS } from "@/lib/data";

export const metadata = { title: "Overview — ENSCA console" };

const branch = BRANCHES[0];
const totalUsed = GROUPS.reduce((sum, g) => sum + g.used, 0);
const totalPool = GROUPS.reduce((sum, g) => sum + g.pool, 0);
const devices = GROUPS.reduce((sum, g) => sum + g.devices, 0);

const ENFORCEMENT = [
  ["Resource", "wifi"],
  ["Enforcer", "fedora-vm · enp10s0u1"],
  ["Identity", "DHCP lease → Membership"],
  ["Resolution", "Membership → Member → deny"],
  ["Revocation", "on next check"],
];

export default function OverviewPage() {
  return (
    <>
      <PageHeader
        eyebrow="Branch overview"
        title={branch.ens}
        meta={`${branch.venue} · ${branch.window}`}
      />

      <div className="px-5 py-6 lg:px-8">
        <Panel className="grid grid-cols-2 divide-x divide-y divide-rule sm:grid-cols-4 sm:divide-y-0">
          <Stat label="Memberships" value={String(branch.members)} note="onboarded here" />
          <Stat label="Online now" value={String(branch.online)} note={`${devices} devices`} />
          <Stat
            label="Throughput"
            value={totalUsed.toLocaleString()}
            unit="Mbps"
            note={`of ${totalPool.toLocaleString()} provisioned`}
          />
          <Stat label="Groups" value={String(GROUPS.length)} note="isolated VLANs" />
        </Panel>

        <div className="mt-6 grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
          <Panel as="section">
            <PanelHeader
              right={
                <span className="font-mono text-[0.6875rem] text-ink-muted">HTB parent classes</span>
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
            <p className="border-t border-rule px-4 py-3 text-xs leading-relaxed text-ink-muted">
              A member idle inside a group lends capacity to peers up to their own ceiling. A group
              never exceeds its pool, so one group cannot starve another.
            </p>
          </Panel>

          <div className="flex flex-col gap-6">
            <Panel as="section">
              <PanelHeader>Perimeter</PanelHeader>
              <div className="relative h-[168px]">
                <SignalDither
                  motif="radar"
                  cell={3}
                  period={4.5}
                  className="absolute inset-0"
                  label="Radar sweep indicating live presence detection"
                />
              </div>
              <p className="border-t border-rule px-4 py-3 text-xs text-ink-muted">
                Presence is derived from active sessions. A device leaving the branch drops off
                within one lease check.
              </p>
            </Panel>

            <Panel as="section">
              <PanelHeader>Enforcement</PanelHeader>
              <dl className="divide-y divide-rule">
                {ENFORCEMENT.map(([term, detail]) => (
                  <div key={term} className="flex items-baseline justify-between gap-4 px-4 py-2.5">
                    <dt className="label">{term}</dt>
                    <dd className="text-right font-mono text-xs text-ink-80">{detail}</dd>
                  </div>
                ))}
              </dl>
            </Panel>
          </div>
        </div>
      </div>
    </>
  );
}
