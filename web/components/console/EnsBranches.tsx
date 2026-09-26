"use client";

import { Panel, PanelHeader } from "@/components/ui/Panel";
import { useEnsBranches } from "@/lib/hooks/useEns";
import { explorer } from "@/lib/ens/config";

/**
 * Branches, discovered from ENS rather than configured.
 *
 * A branch is a name under the organization that carries a subregistry — that is the domain model,
 * and the index exposes it directly. Its registrar is published as an `ensca.registrar` record,
 * because a registrar is only an EAC role holder and is otherwise invisible. So a new branch shows
 * up here the moment it is registered; nothing in this app has to be redeployed.
 */
export function EnsBranches({ org }: { org: string }) {
  const { branches, indexedBlock, error, isLoading } = useEnsBranches(org);

  return (
    <Panel as="section" className="overflow-hidden">
      <PanelHeader
        right={
          <span className="font-mono text-[0.6875rem] text-ink-muted">
            {indexedBlock ? `ens indexer · block ${indexedBlock}` : org + ".eth"}
          </span>
        }
      >
        Branches of {org + ".eth"}
      </PanelHeader>

      {isLoading ? (
        <p className="px-4 py-10 text-center font-mono text-xs text-ink-muted">
          Discovering branches…
        </p>
      ) : error ? (
        <div role="status" className="px-4 py-10 text-center">
          <p className="font-mono text-xs uppercase tracking-[0.12em] text-ink-muted">
            Indexer unreachable
          </p>
        </div>
      ) : !branches || branches.length === 0 ? (
        <div role="status" className="px-4 py-10 text-center">
          <p className="text-sm text-ink">No branches yet</p>
          <p className="mx-auto mt-1.5 max-w-[46ch] text-sm text-ink-muted">
            A branch is a name in the organization registry with a subregistry of its own. Without
            one it is just a Member name at the organization level.
          </p>
        </div>
      ) : (
        <ul className="grid gap-px bg-rule md:grid-cols-2 xl:grid-cols-3">
          {branches.map((b) => (
            <li key={b.name} className="bg-paper-raise p-4">
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="truncate font-mono text-sm text-ink">{b.label}</h3>
                <span className="shrink-0 font-mono text-xs tabular-nums text-ink-muted">
                  {b.memberCount} member{b.memberCount === 1 ? "" : "s"}
                </span>
              </div>
              <p className="mt-1 truncate font-mono text-xs text-ink-muted">{b.name}</p>

              <dl className="mt-3 space-y-1.5">
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="label">Registry</dt>
                  <dd>
                    <a
                      href={explorer(b.registry)}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-xs text-ink-80 underline decoration-rule underline-offset-2 hover:text-ink"
                    >
                      {b.registry.slice(0, 10)}…
                    </a>
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="label">Registrar</dt>
                  <dd>
                    {b.registrar ? (
                      <a
                        href={explorer(b.registrar)}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-xs text-ink-80 underline decoration-rule underline-offset-2 hover:text-ink"
                      >
                        {b.registrar.slice(0, 10)}…
                      </a>
                    ) : (
                      <span
                        className="font-mono text-xs text-ink-muted"
                        title="No ensca.registrar record, so this branch's roles cannot be read."
                      >
                        not published
                      </span>
                    )}
                  </dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
