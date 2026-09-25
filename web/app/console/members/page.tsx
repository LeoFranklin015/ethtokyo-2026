import { PageHeader } from "@/components/console/PageHeader";
import { MembershipsTable } from "@/components/console/MembershipsTable";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { SourceTag } from "@/components/ui/SourceTag";
import { getBranch, getMemberships } from "@/lib/ens/branch";
import { explorer } from "@/lib/ens/config";

export const metadata = { title: "Memberships — ENSCA console" };

/** Re-read the chain at most twice a minute; memberships change at human pace. */
export const revalidate = 30;

export default async function MembersPage() {
  const [branch, rows] = await Promise.all([getBranch(), getMemberships()]);

  return (
    <>
      <PageHeader
        eyebrow="Branch"
        title="Memberships"
        meta={`${rows.length} in ${branch.branch}`}
        actions={<SourceTag source="chain" />}
      />

      <div className="px-5 py-6 lg:px-8">
        <Panel as="section" className="overflow-hidden">
          <PanelHeader
            right={
              <a
                href={explorer(branch.registry)}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-[0.6875rem] text-ink-muted underline decoration-rule underline-offset-2 hover:text-ink"
              >
                branch registry
              </a>
            }
          >
            Read from the branch registry
          </PanelHeader>
          <MembershipsTable rows={rows} />
          <p className="border-t border-rule px-4 py-3 text-xs leading-relaxed text-ink-muted">
            Rows come from the registrar&rsquo;s <code className="font-mono">Onboarded</code> logs,
            re-checked against the registry so revoked and expired names drop out. Entitlements are
            text records on the branch resolver, keyed by full ENS namehash — the same read an
            enforcer performs at admission.
          </p>
        </Panel>
      </div>
    </>
  );
}
