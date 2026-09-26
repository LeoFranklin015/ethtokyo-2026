import { PageHeader } from "@/components/console/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { SourceTag } from "@/components/ui/SourceTag";
import { getBranches } from "@/lib/ens/branch";
import { DEPLOYMENT, explorer } from "@/lib/ens/config";

export const metadata = { title: "Branches — ENSCA console" };
export const revalidate = 30;

export default async function BranchesPage() {
  const branches = await getBranches();

  return (
    <>
      <PageHeader
        eyebrow="Organization"
        title="Branches"
        meta={`Names under ${DEPLOYMENT.organization} that carry a registry of their own`}
        actions={<SourceTag source="chain" />}
      />

      <div className="px-5 py-6 lg:px-8">
        {branches.length === 0 ? (
          <Panel as="section">
            <div role="status" className="px-4 py-16 text-center">
              <p className="text-sm text-ink">No branches yet</p>
              <p className="mx-auto mt-1.5 max-w-[46ch] text-sm text-ink-muted">
                A branch is a name in the organization registry with a subregistry of its own.
                Without one, it is just a member name at the org level.
              </p>
            </div>
          </Panel>
        ) : (
          <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {branches.map((b) => (
              <li key={b.name}>
                <Panel as="article" className="h-full">
                  <div className="flex items-baseline justify-between gap-3 border-b border-rule px-4 py-3">
                    <h2 className="truncate font-mono text-sm text-ink">{b.label}</h2>
                    <span className="flex shrink-0 items-center gap-1.5 font-mono text-[0.6875rem] text-ink-muted">
                      <span
                        aria-hidden
                        className="size-1.5 rounded-full"
                        style={{ background: b.open ? "var(--signal)" : "var(--ink-faint)" }}
                      />
                      {b.open ? "open" : "closed"}
                    </span>
                  </div>
                  <dl className="px-4 py-3">
                    <dt className="label">Name</dt>
                    <dd className="mt-1 font-mono text-xs break-all text-ink-80">{b.name}</dd>
                    <dt className="label mt-3">Registry</dt>
                    <dd className="mt-1">
                      <a
                        href={explorer(b.registry)}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-xs text-ink-80 underline decoration-rule underline-offset-2 hover:text-ink"
                      >
                        {b.registry.slice(0, 12)}…{b.registry.slice(-4)}
                      </a>
                    </dd>
                  </dl>
                  <p className="border-t border-rule px-4 py-3 font-mono text-xs tabular-nums text-ink-muted">
                    {b.members} membership{b.members === 1 ? "" : "s"}
                  </p>
                </Panel>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
