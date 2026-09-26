"use client";

import useSWR from "swr";
import { PageHeader } from "@/components/console/PageHeader";
import { NoOrgSelected } from "@/components/console/OrgPicker";
import { useOrg } from "@/lib/hooks/useOrg";
import { GroupForm } from "@/components/console/GroupForm";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { useEnsBranches } from "@/lib/hooks/useEns";
import { explorer } from "@/lib/ens/config";
import type { RoleInfo } from "@/lib/ens/read";
import { useState } from "react";
import { api } from "@/lib/api";
import {
  useEnforcerGroups,
  useResources,
  grantAccess,
  revokeAccess,
  type Group,
  type Limits,
  type Resource,
} from "@/lib/hooks/useEnforcer";

/**
 * Groups — the categories people are onboarded into.
 *
 * Read from the branch registrar rather than from config, because a group is on-chain data: an
 * organization can invent one the contract never heard of and it appears here immediately.
 */
export default function GroupsPage() {
  const org = useOrg();
  const { branches, isLoading: branchesLoading } = useEnsBranches(org);
  const withRegistrar = (branches ?? []).filter((b) => b.registrar);
  const [selected, setSelected] = useState<string>("");
  const registrar = selected || withRegistrar[0]?.registrar || "";
  const [bandwidthGroup, setBandwidthGroup] = useState<Group | null>(null);
  const { groups: enforcerGroups } = useEnforcerGroups(org);
  const { resources } = useResources();

  const { data, mutate, isLoading, error } = useSWR<{ groups: RoleInfo[] }>(
    registrar ? `groups:${registrar}` : null,
    async () => {
      const r = await fetch(`/api/ens/groups?registrar=${registrar}`);
      if (!r.ok) throw new Error(`group catalogue unavailable (${r.status})`);
      return r.json();
    },
  );
  const groups = (data?.groups ?? []).filter((g) => g.active);

  // Every figure below belongs to one organization. Without one there is nothing to read,
  // and guessing which is how this console used to answer with somebody else's data.
  if (!org) return <NoOrgSelected />;

  return (
    <>
      <PageHeader
        eyebrow={`${org}.eth`}
        title="Groups"
        meta="Categories of people. A group mints no name — onboarding assigns one."
      />

      <div className="grid gap-6 px-5 py-6 lg:px-8 xl:grid-cols-[1fr_minmax(0,420px)]">
        <Panel as="section" className="overflow-hidden">
          <PanelHeader
            right={
              withRegistrar.length > 1 ? (
                <select
                  value={registrar}
                  onChange={(e) => setSelected(e.target.value)}
                  aria-label="Perimeter"
                  className="h-7 rounded-sharp border border-rule bg-paper px-1.5 font-mono text-[0.6875rem] text-ink"
                >
                  {withRegistrar.map((b) => (
                    <option key={b.label} value={b.registrar ?? ""}>
                      {b.label}
                    </option>
                  ))}
                </select>
              ) : registrar ? (
                <a
                  href={explorer(registrar)}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-[0.6875rem] text-ink-muted underline decoration-rule underline-offset-2 hover:text-ink"
                >
                  registrar
                </a>
              ) : null
            }
          >
            Defined on-chain
          </PanelHeader>

          {error ? (
            <p
              className="px-4 py-10 text-center text-xs leading-relaxed"
              style={{ color: "var(--alert)" }}
              role="status"
            >
              The group catalogue could not be read from the chain. It is not shown rather than
              shown empty.
            </p>
          ) : branchesLoading || (registrar && isLoading) ? (
            <p className="px-4 py-10 text-center font-mono text-xs text-ink-muted">reading…</p>
          ) : !registrar ? (
            <div role="status" className="px-4 py-12 text-center">
              <p className="text-sm text-ink">No perimeter to configure</p>
              <p className="mx-auto mt-1.5 max-w-[42ch] text-sm text-ink-muted">
                Groups belong to a perimeter. Open one first and it will appear here.
              </p>
            </div>
          ) : groups.length === 0 ? (
            <div role="status" className="px-4 py-12 text-center">
              <p className="text-sm text-ink">No groups yet</p>
              <p className="mx-auto mt-1.5 max-w-[42ch] text-sm text-ink-muted">
                Define one on the right. Until a perimeter has at least one group, nobody can be
                onboarded into it.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-rule">
              {groups.map((g) => {
                const enforcerGroup = (enforcerGroups ?? []).find((eg) => eg.name === g.name) ?? null;
                return (
                <li key={g.id} className="px-4 py-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <span className="font-mono text-sm text-ink">{g.name}</span>
                      <div className="mt-1 flex gap-2 font-mono text-[0.6875rem] text-ink-muted">
                        {g.openToOnboarders ? <Tag>open to onboarders</Tag> : <Tag>restricted</Tag>}
                        {g.canOnboard ? <Tag>may onboard</Tag> : null}
                      </div>
                    </div>
                    {enforcerGroup ? (
                      <Button
                        variant="ghost"
                        onClick={() => setBandwidthGroup(enforcerGroup)}
                      >
                        Bandwidth
                      </Button>
                    ) : null}
                  </div>
                  {g.entitlements.length ? (
                    <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                      {g.entitlements.map((e) => (
                        <div key={e.key} className="flex items-baseline gap-1.5">
                          <dt className="font-mono text-[0.6875rem] text-ink-muted">{e.key}</dt>
                          <dd className="font-mono text-[0.6875rem] text-ink-80">{e.value}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : (
                    <p className="mt-2 text-xs text-ink-muted">Publishes no entitlements.</p>
                  )}
                </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <GroupForm org={org} onDone={() => mutate()} />
      </div>

      {bandwidthGroup ? (
        <BandwidthModal
          group={bandwidthGroup}
          resources={resources ?? []}
          onClose={() => setBandwidthGroup(null)}
        />
      ) : null}
    </>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-rule px-2 py-0.5 uppercase tracking-[0.1em]">
      {children}
    </span>
  );
}

/**
 * Edit bandwidth caps for one group across all resources.
 *
 * Each resource gets three caps: per device per day, whole group per day, per ENS name per day.
 * An empty field means unlimited. Saving sends all three caps to avoid partial-replace surprises.
 */
function BandwidthModal({
  group,
  resources,
  onClose,
}: {
  group: Group;
  resources: Resource[];
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-ink/20"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Bandwidth — ${group.name}`}
        className="relative w-full max-w-[520px] max-h-[90vh] overflow-y-auto rounded-sharp border border-rule bg-paper p-5"
      >
        <p className="label">Bandwidth allocation</p>
        <h2 className="mt-1 font-mono text-sm text-ink">{group.name}</h2>
        <p className="mt-2 text-xs leading-relaxed text-ink-muted">
          Daily request caps for this group. Leave a field empty for unlimited. Changes take effect
          immediately — the proxy reads limits on every request.
        </p>

        {resources.length === 0 ? (
          <p className="mt-4 text-sm text-ink-muted">
            No resources configured yet. Add a resource under{" "}
            <a href="/console/resources" className="underline decoration-rule underline-offset-2">Resources</a>.
          </p>
        ) : (
          <div className="mt-4 space-y-4">
            {resources.map((r) => (
              <ResourceCaps key={r.id} group={group} resource={r} />
            ))}
          </div>
        )}

        <div className="mt-5">
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  );
}

function ResourceCaps({ group, resource }: { group: Group; resource: Resource }) {
  const [perDevice, setPerDevice] = useState("");
  const [perGroup, setPerGroup] = useState("");
  const [perEns, setPerEns] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Load current limits once on mount
  useSWR<Limits>(
    `group-limits:${group.id}:${resource.id}`,
    async () => {
      try {
        return await api.get<Limits>(`groups/${group.id}/limits/${resource.id}`);
      } catch (e) {
        // 404 means no grant exists yet — treat as all-unlimited
        if (e && typeof e === "object" && "status" in e && (e as { status: number }).status === 404) {
          return { per_device_per_day: null, group_per_day: null, per_ens_per_day: null };
        }
        throw e;
      }
    },
    {
      onSuccess(data) {
        if (!loaded) {
          setPerDevice(data.per_device_per_day !== null ? String(data.per_device_per_day) : "");
          setPerGroup(data.group_per_day !== null ? String(data.group_per_day) : "");
          setPerEns(data.per_ens_per_day !== null ? String(data.per_ens_per_day) : "");
          setLoaded(true);
        }
      },
    },
  );

  const valid = [perDevice, perGroup, perEns].every(
    (v) => v.trim() === "" || /^\d+$/.test(v.trim()),
  );

  async function save() {
    setBusy(true);
    setMessage(null);
    setSaved(false);
    try {
      const limits: Limits = {
        per_device_per_day: perDevice.trim() ? Number(perDevice.trim()) : null,
        group_per_day: perGroup.trim() ? Number(perGroup.trim()) : null,
        per_ens_per_day: perEns.trim() ? Number(perEns.trim()) : null,
      };
      if (limits.per_device_per_day === null && limits.group_per_day === null && limits.per_ens_per_day === null) {
        await revokeAccess(group.id, resource.id);
      } else {
        await grantAccess(group.id, resource.id, limits);
      }
      setSaved(true);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-sharp border border-rule px-4 py-3">
      <p className="font-mono text-xs text-ink">
        {resource.slug}
        {!resource.enabled ? (
          <span className="ml-2 text-ink-muted">(disabled)</span>
        ) : null}
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <CapField label="Per device / day" value={perDevice} onChange={setPerDevice} />
        <CapField label="Whole group / day" value={perGroup} onChange={setPerGroup} />
        <CapField label="Per ENS / day" value={perEns} onChange={setPerEns} />
      </div>
      {message ? (
        <p className="mt-2 text-xs" style={{ color: "var(--alert)" }} role="status">{message}</p>
      ) : saved ? (
        <p className="mt-2 font-mono text-xs text-ink-muted" role="status">saved</p>
      ) : null}
      <div className="mt-3">
        <Button variant="outline" onClick={save} disabled={!valid || busy || !loaded}>
          {busy ? "Saving…" : "Save caps"}
        </Button>
      </div>
    </div>
  );
}

function CapField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="block text-[0.6875rem] text-ink-muted">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/[^0-9]/g, ""))}
        inputMode="numeric"
        placeholder="unlimited"
        className="mt-1 h-9 w-full rounded-sharp border border-rule bg-paper px-2 font-mono text-xs tabular-nums text-ink placeholder:text-ink-faint"
      />
    </label>
  );
}
