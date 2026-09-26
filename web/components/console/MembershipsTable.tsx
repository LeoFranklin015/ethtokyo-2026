import type { MembershipRow } from "@/lib/ens/branch";
import { explorer } from "@/lib/ens/config";
import { RoleChip } from "@/components/ui/RoleChip";

const COLUMNS = ["Membership", "Role", "Own roles", "Entitlements", "Owner"];

function short(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function MembershipsTable({ rows }: { rows: MembershipRow[] }) {
  if (rows.length === 0) {
    return (
      <div role="status" className="px-4 py-16 text-center">
        <p className="text-sm text-ink">No memberships in this branch</p>
        <p className="mx-auto mt-1.5 max-w-[44ch] text-sm text-ink-muted">
          Onboarding mints a subname under the branch registry and writes its entitlements to the
          resolver. Until then nobody reaches the network.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] border-collapse text-left">
        <caption className="sr-only">
          Memberships read from the branch registry, with role, registry permissions and resolver
          entitlements
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
          {rows.map((row) => (
            <tr key={row.label} className="transition-colors hover:bg-ink/5">
              <th scope="row" className="px-4 py-3 text-left font-normal">
                <span className="font-mono text-sm text-ink">{row.label}</span>
                <span className="font-mono text-sm text-ink-muted">
                  .{row.name.slice(row.label.length + 1)}
                </span>
              </th>
              <td className="px-4 py-3">
                <RoleChip role={row.role} />
              </td>
              <td className="px-4 py-3">
                {row.ownRoles === 0n ? (
                  <span className="font-mono text-xs text-ink-muted">
                    none · cannot edit own records
                  </span>
                ) : (
                  <span className="font-mono text-xs text-ink-80">
                    0x{row.ownRoles.toString(16)}
                  </span>
                )}
              </td>
              <td className="px-4 py-3">
                <dl className="flex flex-wrap gap-x-3 gap-y-0.5">
                  {Object.entries(row.entitlements).map(([k, v]) => (
                    <div key={k} className="flex items-baseline gap-1">
                      <dt className="font-mono text-[0.6875rem] text-ink-muted">{k}</dt>
                      <dd className="font-mono text-[0.6875rem] text-ink-80">{v}</dd>
                    </div>
                  ))}
                </dl>
              </td>
              <td className="px-4 py-3">
                <a
                  href={explorer(row.owner)}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-xs text-ink-muted underline decoration-rule underline-offset-2 hover:text-ink"
                >
                  {short(row.owner)}
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
