"use client";

import { PageHeader } from "@/components/console/PageHeader";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { ROLES, ORG } from "@/lib/config";
import { GroupForm } from "@/components/console/GroupForm";

// Roles is pure static config — no API needed, no "use client" required
export default function RolesPage() {
  return (
    <>
      <PageHeader eyebrow={ORG.ens} title="Roles" />
      <div className="px-5 py-6 lg:px-8 space-y-6">
        <div className="max-w-[560px]">
          <GroupForm />
        </div>
        <Panel as="section">
          <PanelHeader>Entitlements</PanelHeader>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px] border-collapse text-left">
              <thead>
                <tr className="border-b border-rule">
                  {["Role", "Group", "VLAN", "Rate Mbps", "Ceil Mbps"].map(h => (
                    <th key={h} scope="col" className="label px-4 py-2.5 font-normal">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {ROLES.map(r => (
                  <tr key={r.name} className="hover:bg-ink/5">
                    <td className="px-4 py-2.5 font-mono text-xs text-ink">{r.name}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-ink-80">{r.group}</td>
                    <td className="px-4 py-2.5 font-mono text-xs tabular-nums text-ink-80">{r.vlan}</td>
                    <td className="px-4 py-2.5 font-mono text-xs tabular-nums text-ink-80">{r.rate}</td>
                    <td className="px-4 py-2.5 font-mono text-xs tabular-nums text-ink-80">{r.ceil}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
        <Panel as="section">
          <PanelHeader>Permissions</PanelHeader>
          <div className="divide-y divide-rule">
            {ROLES.map(r => (
              <div key={r.name} className="flex items-start gap-4 px-4 py-3">
                <span className="w-24 shrink-0 font-mono text-xs text-ink">{r.name}</span>
                <span className="text-sm text-ink-muted">{r.summary}</span>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </>
  );
}
