"use client";

import { PageHeader } from "@/components/console/PageHeader";
import { Button } from "@/components/ui/Button";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { RoleChip } from "@/components/ui/RoleChip";
import { useUsers } from "@/lib/hooks/useUsers";
import { useSessions } from "@/lib/hooks/useSessions";
import type { RoleName } from "@/lib/data";

const TIER_ROLE: Record<string, RoleName> = {
  basic: "hacker",
  staff: "organizer",
  vip: "mentor",
};

function fmtBytes(b: number): string {
  if (b > 1_000_000) return `${(b / 1_000_000).toFixed(1)} MB`;
  if (b > 1_000) return `${(b / 1_000).toFixed(0)} KB`;
  return `${b} B`;
}

export default function MembersPage() {
  const branchLabel = process.env.NEXT_PUBLIC_BRANCH_LABEL ?? "branch";
  const branchEns = `${branchLabel}.${process.env.NEXT_PUBLIC_ORG_ENS ?? ""}`;

  const { data: usersData, isLoading } = useUsers();
  const { data: sessionsData } = useSessions(true);

  const users = usersData?.users ?? [];
  const activeSessions = sessionsData?.sessions ?? [];
  const sessionsByUser = new Map(activeSessions.map(s => [s.user_id, s]));

  const COLUMNS = ["Membership", "Role", "Address", "Devices", "Data out", "State"];

  if (isLoading) {
    return <div className="px-5 py-12 text-center font-mono text-xs text-ink-muted">Loading…</div>;
  }

  return (
    <>
      <PageHeader
        eyebrow="Branch"
        title="Memberships"
        meta={`${users.length} at ${branchEns}`}
        actions={<Button variant="solid">Onboard member</Button>}
      />

      <div className="px-5 py-6 lg:px-8">
        <Panel as="section" className="overflow-hidden">
          <PanelHeader
            right={<span className="font-mono text-[0.6875rem] text-ink-muted">{activeSessions.length} online</span>}
          >
            All memberships
          </PanelHeader>

          {users.length === 0 ? (
            <div role="status" className="px-4 py-16 text-center">
              <p className="text-sm text-ink">No memberships yet</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] border-collapse text-left">
                <caption className="sr-only">Memberships at {branchEns}</caption>
                <thead>
                  <tr className="border-b border-rule">
                    {COLUMNS.map((h) => (
                      <th key={h} scope="col" className="label px-4 py-2.5 font-normal">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-rule">
                  {users.map((u) => {
                    const session = sessionsByUser.get(u.id);
                    const online = !!session;
                    const label = u.ens_name?.split(".")[0] ?? u.username;
                    const addrFull = u.wallet_address ?? "";
                    const addrShort = addrFull ? `${addrFull.slice(0, 5)}…${addrFull.slice(-4)}` : "—";
                    const tier = activeSessions.find(s => s.user_id === u.id)?.network_tier ?? "basic";
                    const role: RoleName = TIER_ROLE[tier] ?? "hacker";
                    const bytesOut = session?.bytes_out ?? 0;
                    return (
                      <tr key={u.id} className="transition-colors hover:bg-ink/5">
                        <th scope="row" className="px-4 py-3 text-left font-normal">
                          <span className="font-mono text-sm text-ink">{label}</span>
                          <span className="font-mono text-sm text-ink-muted">.{branchLabel}</span>
                        </th>
                        <td className="px-4 py-3"><RoleChip role={role} /></td>
                        <td className="px-4 py-3 font-mono text-xs tabular-nums text-ink-80">{addrShort}</td>
                        <td className="px-4 py-3 font-mono text-xs tabular-nums text-ink-80">
                          {activeSessions.filter(s => s.user_id === u.id).length}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs tabular-nums text-ink-80">
                          {online ? fmtBytes(bytesOut) : "—"}
                        </td>
                        <td className="px-4 py-3">
                          <span className="inline-flex items-center gap-1.5 font-mono text-xs">
                            <span aria-hidden className="size-1.5 rounded-full" style={{ background: online ? "var(--signal)" : "var(--ink-faint)" }} />
                            <span className={online ? "text-ink-80" : "text-ink-muted"}>{online ? "admitted" : "offline"}</span>
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
