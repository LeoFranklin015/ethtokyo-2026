"use client";

import { Panel, PanelHeader } from "@/components/ui/Panel";
import { useEnsMemberships } from "@/lib/hooks/useEns";
import { ENS, explorer } from "@/lib/ens/config";

const COLUMNS = ["Membership", "Member name", "Role", "Own roles", "Entitlements"];

function short(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Memberships as ENS sees them.
 *
 * Deliberately separate from the proxy-backed table: that one answers "who is on the network right
 * now", this one answers "who holds a name and what does it grant". Same people, different source
 * of truth, and conflating them would hide which is which.
 */
export function EnsMemberships() {
  const { memberships, error, isLoading } = useEnsMemberships();

  return (
    <Panel as="section" className="overflow-hidden">
      <PanelHeader
        right={
          <a
            href={explorer(ENS.branchRegistrar)}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[0.6875rem] text-ink-muted underline decoration-rule underline-offset-2 hover:text-ink"
          >
            {ENS.branch}
          </a>
        }
      >
        On-chain memberships
      </PanelHeader>

      {isLoading ? (
        <p className="px-4 py-10 text-center font-mono text-xs text-ink-muted">
          Reading the branch registry…
        </p>
      ) : error ? (
        <div role="status" className="px-4 py-10 text-center">
          <p className="font-mono text-xs uppercase tracking-[0.12em] text-ink-muted">
            Chain read failed
          </p>
          <p className="mx-auto mt-2 max-w-[44ch] text-xs leading-relaxed text-ink-muted">
            The registry could not be reached. No figure is shown rather than a stale one.
          </p>
        </div>
      ) : !memberships || memberships.length === 0 ? (
        <div role="status" className="px-4 py-10 text-center">
          <p className="text-sm text-ink">No memberships in this branch</p>
          <p className="mx-auto mt-1.5 max-w-[44ch] text-sm text-ink-muted">
            Onboarding mints a subname under the branch registry and writes its entitlements in the
            same transaction.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse text-left">
            <caption className="sr-only">
              Memberships read from the branch registry, with role, registry permissions and
              resolver entitlements
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
              {memberships.map((m) => (
                <tr key={m.label} className="transition-colors hover:bg-ink/5">
                  <th scope="row" className="px-4 py-3 text-left font-normal">
                    <span className="font-mono text-sm text-ink">{m.label}</span>
                    <span className="font-mono text-sm text-ink-muted">
                      .{ENS.branch}
                    </span>
                    <a
                      href={explorer(m.owner)}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-0.5 block font-mono text-[0.6875rem] text-ink-muted underline decoration-rule underline-offset-2 hover:text-ink"
                    >
                      {short(m.owner)}
                    </a>
                  </th>
                  <td className="px-4 py-3 font-mono text-xs text-ink-80">
                    {m.memberName ?? <span className="text-ink-muted">—</span>}
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-rule px-2 py-0.5 font-mono text-[0.6875rem] uppercase tracking-[0.1em] text-ink-80">
                      {m.role}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {m.ownRoles === "0" ? (
                      <span className="font-mono text-xs text-ink-muted">
                        none · cannot edit own records
                      </span>
                    ) : (
                      <span className="font-mono text-xs text-ink-80">
                        0x{BigInt(m.ownRoles).toString(16)}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <dl className="flex flex-wrap gap-x-3 gap-y-0.5">
                      {Object.entries(m.entitlements).map(([k, v]) => (
                        <div key={k} className="flex items-baseline gap-1">
                          <dt className="font-mono text-[0.6875rem] text-ink-muted">{k}</dt>
                          <dd className="font-mono text-[0.6875rem] text-ink-80">{v}</dd>
                        </div>
                      ))}
                    </dl>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="border-t border-rule px-4 py-3 text-xs leading-relaxed text-ink-muted">
        Rows come from the registrar&rsquo;s <code className="font-mono">Onboarded</code> logs,
        re-checked against the registry so revoked names drop out. Entitlements are resolver text
        records at the membership&rsquo;s full ENS namehash — the same read an enforcer performs at
        admission.
      </p>
    </Panel>
  );
}
