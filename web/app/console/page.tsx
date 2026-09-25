import { Rail } from "@/components/Rail";
import { SiteHeader } from "@/components/SiteHeader";
import { Meter } from "@/components/ui/Meter";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { RoleChip } from "@/components/ui/RoleChip";
import { Stat } from "@/components/ui/Stat";
import { BRANCHES, GROUPS, MEMBERSHIPS, ORG } from "@/lib/data";

export const metadata = { title: "Console — ENSCA" };

const branch = BRANCHES[0];
const totalUsed = GROUPS.reduce((sum, g) => sum + g.used, 0);
const totalPool = GROUPS.reduce((sum, g) => sum + g.pool, 0);
const devices = GROUPS.reduce((sum, g) => sum + g.devices, 0);

export default function ConsolePage() {
  return (
    <>
      <SiteHeader current="/console" />

      <main id="main" className="mx-auto w-full max-w-[1180px] flex-1 px-5 pb-20">
        {/* Branch context ───────────────────────────────────────────────── */}
        <div className="flex flex-wrap items-end justify-between gap-4 border-b border-rule py-6">
          <div>
            <p className="label">{ORG.name} · branch</p>
            <h1 className="mt-2 font-mono text-2xl tracking-tight text-ink">{branch.ens}</h1>
            <p className="mt-1.5 text-sm text-ink-55">
              {branch.venue} · {branch.window}
            </p>
          </div>
          <p className="flex items-center gap-2 font-mono text-xs text-ink-55">
            <span aria-hidden className="size-1.5 rounded-full bg-signal" />
            Enforcer online · records cached 12s ago
          </p>
        </div>

        {/* KPI row — hero numbers, no plots ─────────────────────────────── */}
        <Panel className="mt-6 grid grid-cols-2 divide-x divide-rule sm:grid-cols-4">
          <Stat label="Memberships" value={branch.members.toString()} note="onboarded at this branch" />
          <Stat label="Online now" value={branch.online.toString()} note={`${devices} devices admitted`} />
          <Stat
            label="Throughput"
            value={totalUsed.toLocaleString()}
            unit="Mbps"
            note={`of ${totalPool.toLocaleString()} Mbps provisioned`}
          />
          <Stat label="Groups" value={GROUPS.length.toString()} note="isolated VLANs" />
        </Panel>

        <div className="mt-6 grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
          {/* Group utilisation ─────────────────────────────────────────── */}
          <Panel as="section">
            <PanelHeader right={<span className="font-mono text-[0.6875rem] text-ink-35">HTB parent classes</span>}>
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
            <p className="border-t border-rule px-4 py-3 text-xs leading-relaxed text-ink-55">
              A member idle inside a group lends capacity to peers up to their own ceiling. A group
              never exceeds its pool, so one group cannot starve another.
            </p>
          </Panel>

          {/* Enforcement ───────────────────────────────────────────────── */}
          <Panel as="section">
            <PanelHeader>Enforcement</PanelHeader>
            <dl className="divide-y divide-rule">
              {[
                ["Resource", "wifi"],
                ["Enforcer", "fedora-vm · enp10s0u1"],
                ["Identity", "DHCP lease → Membership"],
                ["Resolution", "Membership → Member → deny"],
                ["Revocation", "propagates on next check"],
              ].map(([term, detail]) => (
                <div key={term} className="flex items-baseline justify-between gap-4 px-4 py-2.5">
                  <dt className="label">{term}</dt>
                  <dd className="text-right font-mono text-xs text-ink-80">{detail}</dd>
                </div>
              ))}
            </dl>
          </Panel>
        </div>

        {/* Memberships ──────────────────────────────────────────────────── */}
        <Panel as="section" className="mt-6 overflow-hidden">
          <PanelHeader right={<span className="font-mono text-[0.6875rem] text-ink-35">{MEMBERSHIPS.length} shown</span>}>
            Memberships
          </PanelHeader>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px] border-collapse text-left">
              <caption className="sr-only">
                Memberships at {branch.ens}, with role, devices and current rate
              </caption>
              <thead>
                <tr className="border-b border-rule">
                  {["Membership", "Role", "Devices", "Rate", "State"].map((h) => (
                    <th key={h} scope="col" className="label px-4 py-2.5 font-normal">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {MEMBERSHIPS.map((m) => (
                  <tr key={m.label} className="transition-colors hover:bg-ink/4">
                    <th scope="row" className="px-4 py-3 text-left font-normal">
                      <span className="font-mono text-sm text-ink">{m.label}</span>
                      <span className="font-mono text-sm text-ink-35">.{branch.label}</span>
                      <span className="mt-0.5 block font-mono text-[0.6875rem] text-ink-35">
                        {m.address}
                      </span>
                    </th>
                    <td className="px-4 py-3">
                      <RoleChip role={m.role} />
                    </td>
                    <td className="px-4 py-3 font-mono text-xs tabular-nums text-ink-80">
                      {m.devices}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs tabular-nums text-ink-80">
                      {m.online ? `${m.rate.toFixed(1)} Mbps` : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1.5 font-mono text-xs">
                        <span
                          aria-hidden
                          className="size-1.5 rounded-full"
                          style={{ background: m.online ? "var(--signal)" : "var(--ink-35)" }}
                        />
                        <span className={m.online ? "text-ink-80" : "text-ink-35"}>
                          {m.online ? "admitted" : "offline"}
                        </span>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        {/* Branches ─────────────────────────────────────────────────────── */}
        <Rail label="Branches" className="mt-12">
          {BRANCHES.map((b) => (
            <Panel key={b.ens} as="article" className="w-[260px] shrink-0 snap-start p-4">
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="font-mono text-sm text-ink">{b.label}</h3>
                <span className="label">{b.status}</span>
              </div>
              <p className="mt-2 text-xs text-ink-55">{b.venue}</p>
              <p className="mt-0.5 font-mono text-xs text-ink-35">{b.window}</p>
              <p className="mt-4 font-mono text-xs tabular-nums text-ink-80">
                {b.members} memberships
                {b.status === "open" ? ` · ${b.online} online` : ""}
              </p>
            </Panel>
          ))}
        </Rail>
      </main>
    </>
  );
}
