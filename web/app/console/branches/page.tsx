import { PageHeader } from "@/components/console/PageHeader";
import { Button } from "@/components/ui/Button";
import { Panel } from "@/components/ui/Panel";
import { BRANCHES, ORG } from "@/lib/data";

export const metadata = { title: "Branches — ENSCA console" };

const STATUS_COPY = {
  open: "Admitting now",
  scheduled: "Opens later",
  archived: "Closed",
} as const;

export default function BranchesPage() {
  return (
    <>
      <PageHeader
        eyebrow="Organization"
        title="Branches"
        meta={`${BRANCHES.length} locations under ${ORG.ens}`}
        actions={<Button variant="solid">Create branch</Button>}
      />

      <div className="px-5 py-6 lg:px-8">
        <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {BRANCHES.map((b) => (
            <li key={b.ens}>
              <Panel as="article" className="h-full">
                <div className="flex items-baseline justify-between gap-3 border-b border-rule px-4 py-3">
                  <h2 className="truncate font-mono text-sm text-ink">{b.label}</h2>
                  <span className="flex shrink-0 items-center gap-1.5 font-mono text-[0.6875rem] text-ink-muted">
                    <span
                      aria-hidden
                      className="size-1.5 rounded-full"
                      style={{
                        background: b.status === "open" ? "var(--signal)" : "var(--ink-faint)",
                      }}
                    />
                    {STATUS_COPY[b.status]}
                  </span>
                </div>
                <dl className="px-4 py-3">
                  <dt className="label">Venue</dt>
                  <dd className="mt-1 text-sm text-ink-80">{b.venue}</dd>
                  <dt className="label mt-3">Window</dt>
                  <dd className="mt-1 font-mono text-xs text-ink-80">{b.window}</dd>
                </dl>
                <p className="border-t border-rule px-4 py-3 font-mono text-xs tabular-nums text-ink-muted">
                  {b.members} memberships
                  {b.status === "open" ? ` · ${b.online} online` : ""}
                </p>
              </Panel>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
