import { PageHeader } from "@/components/console/PageHeader";
import { Button } from "@/components/ui/Button";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { RoleChip } from "@/components/ui/RoleChip";
import { BRANCHES, MEMBERSHIPS } from "@/lib/data";

export const metadata = { title: "Memberships — ENSCA console" };

const branch = BRANCHES[0];
const COLUMNS = ["Membership", "Role", "Devices", "Rate", "State"];

export default function MembersPage() {
  return (
    <>
      <PageHeader
        eyebrow="Branch"
        title="Memberships"
        meta={`${MEMBERSHIPS.length} at ${branch.ens}`}
        actions={<Button variant="solid">Onboard member</Button>}
      />

      <div className="px-5 py-6 lg:px-8">
        <Panel as="section" className="overflow-hidden">
          <PanelHeader
            right={
              <span className="font-mono text-[0.6875rem] text-ink-muted">
                {MEMBERSHIPS.filter((m) => m.online).length} online
              </span>
            }
          >
            All memberships
          </PanelHeader>

          {MEMBERSHIPS.length === 0 ? (
            <div role="status" className="px-4 py-16 text-center">
              <p className="text-sm text-ink">No memberships yet</p>
              <p className="mx-auto mt-1.5 max-w-[40ch] text-sm text-ink-muted">
                Onboarding mints a subname under this branch and writes its entitlements. Nobody
                reaches the network until they hold one.
              </p>
              <Button variant="solid" className="mt-5">
                Onboard the first member
              </Button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] border-collapse text-left">
                <caption className="sr-only">
                  Memberships at {branch.ens}, with role, devices and current rate
                </caption>
                <thead>
                  <tr className="border-b border-rule">
                    {COLUMNS.map((h) => (
                      <th key={h} scope="col" className="label px-4 py-2.5 font-normal">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-rule">
                  {MEMBERSHIPS.map((m) => (
                    <tr key={m.label} className="transition-colors hover:bg-ink/5">
                      <th scope="row" className="px-4 py-3 text-left font-normal">
                        <span className="font-mono text-sm text-ink">{m.label}</span>
                        <span className="font-mono text-sm text-ink-muted">.{branch.label}</span>
                        <span className="mt-0.5 block font-mono text-[0.6875rem] text-ink-muted">
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
                            style={{ background: m.online ? "var(--signal)" : "var(--ink-faint)" }}
                          />
                          <span className={m.online ? "text-ink-80" : "text-ink-muted"}>
                            {m.online ? "admitted" : "offline"}
                          </span>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
