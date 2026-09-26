"use client";

import { PageHeader } from "@/components/console/PageHeader";
import { NoOrgSelected } from "@/components/console/OrgPicker";
import { useOrg } from "@/lib/hooks/useOrg";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { useUsers } from "@/lib/hooks/useUsers";
import { useSessions } from "@/lib/hooks/useSessions";
import { EnsMemberships } from "@/components/console/EnsMemberships";
import { OnboardForm } from "@/components/console/OnboardForm";

function fmtBytes(b: number): string {
  if (b > 1_000_000) return `${(b / 1_000_000).toFixed(1)} MB`;
  if (b > 1_000) return `${(b / 1_000).toFixed(0)} KB`;
  return `${b} B`;
}

export default function MembersPage() {
  const org = useOrg();
  // One enforcer serves one branch, so the branch is configuration — not "whichever branch
  // sorts first", which is what this used to be while the counts below are enforcer-wide.
  const branchEns = process.env.NEXT_PUBLIC_BRANCH_ENS?.trim() || null;

  const { data: usersData, isLoading, error } = useUsers(org);
  const { data: sessionsData, error: sessionsError } = useSessions(org, true);

  const users = usersData?.users ?? [];
  const activeSessions = sessionsData?.sessions ?? [];
  const sessionsByUser = new Map(activeSessions.map(s => [s.user_id, s]));

  // No Role column: the enforcer does not know the on-chain role, and the previous version
  // invented one from `network_tier`, defaulting every offline member to "hacker". The real
  // role is in the ENS table directly above this one.
  const COLUMNS = ["Membership", "Address", "Sessions", "Proxied out", "State"];

  // Every figure below belongs to one organization. Without one there is nothing to read,
  // and guessing which is how this console used to answer with somebody else's data.
  if (!org) return <NoOrgSelected />;

  return (
    <>
      <PageHeader
        eyebrow="Branch"
        title="Memberships"
        meta={error ? undefined : `${usersData?.total ?? users.length} known to this enforcer${branchEns ? ` · ${branchEns}` : ""}`}
      />

      <div className="px-5 py-6 lg:px-8 space-y-6">
        <div className="max-w-[560px]">
          <OnboardForm org={org} />
        </div>

        <EnsMemberships org={org} />

        <Panel as="section" className="overflow-hidden">
          <PanelHeader
            right={
              <span className="font-mono text-[0.6875rem] text-ink-muted">
                {sessionsError ? "session count unavailable" : `${activeSessions.length} online`}
              </span>
            }
          >
            All memberships
          </PanelHeader>

          {error ? (
            <div role="status" className="px-4 py-16 text-center">
              <p className="text-sm" style={{ color: "var(--alert)" }}>
                The enforcer did not answer
              </p>
              <p className="mx-auto mt-1.5 max-w-[46ch] text-sm text-ink-muted">
                This table is not shown rather than shown empty — an unreachable enforcer is not
                a branch with nobody in it. The ENS memberships above are unaffected.
              </p>
            </div>
          ) : isLoading ? (
            <p className="px-4 py-10 text-center font-mono text-xs text-ink-muted">
              Reading the enforcer…
            </p>
          ) : users.length === 0 ? (
            <div role="status" className="px-4 py-16 text-center">
              <p className="text-sm text-ink">Nobody admitted yet</p>
              <p className="mx-auto mt-1.5 max-w-[44ch] text-sm text-ink-muted">
                Identity above comes from ENS; this table shows who the branch enforcer has
                actually admitted.
              </p>
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
                    const bytesOut = session?.bytes_out ?? 0;
                    return (
                      <tr key={u.id} className="transition-colors hover:bg-ink/5">
                        <th scope="row" className="px-4 py-3 text-left font-normal">
                          <span className="font-mono text-sm text-ink">
                            {u.ens_name ?? label}
                          </span>
                        </th>
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
