import { PageHeader } from "@/components/console/PageHeader";
import { Button } from "@/components/ui/Button";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { ORG, ROLES } from "@/lib/data";

export const metadata = { title: "Roles — ENSCA console" };

export default function RolesPage() {
  return (
    <>
      <PageHeader
        eyebrow="Organization"
        title="Role catalogue"
        meta={`Defined once on ${ORG.ens}, granted per membership`}
        actions={<Button>New role</Button>}
      />

      <div className="px-5 py-6 lg:px-8">
        <div className="grid gap-6 xl:grid-cols-2">
          {/* Permissions: what a role may DO in the console */}
          <Panel as="section" className="overflow-hidden">
            <PanelHeader
              right={<span className="font-mono text-[0.6875rem] text-ink-muted">registrar roles</span>}
            >
              Permissions
            </PanelHeader>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px] border-collapse text-left">
                <caption className="sr-only">Console permissions granted by each role</caption>
                <thead>
                  <tr className="border-b border-rule">
                    <th scope="col" className="label px-4 py-2.5 font-normal">Role</th>
                    <th scope="col" className="label px-4 py-2.5 font-normal">Grants</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-rule">
                  {ROLES.map((role) => (
                    <tr key={role.name}>
                      <th scope="row" className="px-4 py-3 text-left font-mono text-sm font-normal text-ink">
                        {role.name}
                      </th>
                      <td className="px-4 py-3">
                        {role.permissions.length === 0 ? (
                          <span className="font-mono text-xs text-ink-muted">none</span>
                        ) : (
                          <ul className="flex flex-wrap gap-1">
                            {role.permissions.map((p) => (
                              <li
                                key={p}
                                className="rounded-sharp border border-rule px-1.5 py-0.5 font-mono text-[0.6875rem] text-ink-80"
                              >
                                {p}
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          {/* Entitlements: what a role GETS from the infrastructure */}
          <Panel as="section" className="overflow-hidden">
            <PanelHeader
              right={<span className="font-mono text-[0.6875rem] text-ink-muted">wifi resource</span>}
            >
              Entitlements
            </PanelHeader>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px] border-collapse text-left">
                <caption className="sr-only">Network entitlements granted by each role</caption>
                <thead>
                  <tr className="border-b border-rule">
                    <th scope="col" className="label px-4 py-2.5 font-normal">Role</th>
                    <th scope="col" className="label px-4 py-2.5 font-normal">Group</th>
                    <th scope="col" className="label px-4 py-2.5 font-normal">VLAN</th>
                    <th scope="col" className="label px-4 py-2.5 font-normal">Rate / ceil</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-rule">
                  {ROLES.map((role) => (
                    <tr key={role.name}>
                      <th scope="row" className="px-4 py-3 text-left font-mono text-sm font-normal text-ink">
                        {role.name}
                      </th>
                      <td className="px-4 py-3 font-mono text-xs text-ink-80">{role.group}</td>
                      <td className="px-4 py-3 font-mono text-xs tabular-nums text-ink-80">
                        {role.vlan}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs tabular-nums text-ink-80">
                        {role.rate} / {role.ceil} Mbps
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="border-t border-rule px-4 py-3 text-xs leading-relaxed text-ink-muted">
              Permissions govern the console. Entitlements govern the infrastructure. The two move
              independently — a volunteer may onboard members while capped at 10 Mbps.
            </p>
          </Panel>
        </div>
      </div>
    </>
  );
}
