"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import useSWR from "swr";
import { PageHeader } from "@/components/console/PageHeader";
import { NoOrgSelected } from "@/components/console/OrgPicker";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { useOrg } from "@/lib/hooks/useOrg";
import { useEnsBranches, useEnsMemberships } from "@/lib/hooks/useEns";
import { useEnsWrites } from "@/lib/ens/useEnsWrites";
import { useAccount } from "wagmi";
import { explorer } from "@/lib/ens/config";
import type { RoleInfo } from "@/lib/ens/read";
import type { Address } from "viem";
import {
  useEnforcerGroups,
  useResources,
  grantAccess,
  revokeAccess,
  type Group,
  type Limits,
  type Resource,
} from "@/lib/hooks/useEnforcer";
import { api } from "@/lib/api";

export default function PerimeterDetailPage() {
  const org = useOrg();
  const params = useParams<{ label: string }>();
  const label = params.label;

  const { branches, isLoading: branchesLoading } = useEnsBranches(org);
  const branch = (branches ?? []).find((b) => b.label === label);

  const { data: groupData, mutate: mutateGroups, isLoading: groupsLoading } = useSWR<{ groups: RoleInfo[] }>(
    branch?.registrar ? `groups:${branch.registrar}` : null,
    async () => {
      const r = await fetch(`/api/ens/groups?registrar=${branch!.registrar}`);
      if (!r.ok) throw new Error(`groups ${r.status}`);
      return r.json();
    },
  );
  const groups = (groupData?.groups ?? []).filter((g) => g.active);

  const { memberships, source, indexedBlock, stale, isLoading: membersLoading, error: membersError } =
    useEnsMemberships(org, label);

  const { groups: enforcerGroups } = useEnforcerGroups(org);
  const { resources } = useResources();

  const [settingsTarget, setSettingsTarget] = useState<{ group: RoleInfo; enforcerGroup: Group | null } | null>(null);

  if (!org) return <NoOrgSelected />;

  const fullName = label && org ? `${label}.${org}.eth` : label;

  return (
    <>
      <PageHeader
        eyebrow={`${org}.eth`}
        title={label}
        meta={fullName}
      />

      <div className="space-y-6 px-5 py-6 lg:px-8">
        {/* Branch metadata */}
        {branch ? (
          <Panel as="section">
            <PanelHeader>Contracts</PanelHeader>
            <dl className="divide-y divide-rule">
              {[
                { label: "Registry", value: branch.registry },
                { label: "Registrar", value: branch.registrar ?? null },
              ].map(({ label: dl, value }) => (
                <div key={dl} className="flex items-baseline justify-between gap-3 px-4 py-3">
                  <dt className="label shrink-0">{dl}</dt>
                  <dd>
                    {value ? (
                      <a
                        href={explorer(value)}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-xs text-ink-80 underline decoration-rule underline-offset-2 hover:text-ink"
                      >
                        {value.slice(0, 10)}…{value.slice(-6)}
                      </a>
                    ) : (
                      <span className="font-mono text-xs text-ink-muted">not published</span>
                    )}
                  </dd>
                </div>
              ))}
              {branch.memberCount !== null ? (
                <div className="flex items-baseline justify-between gap-3 px-4 py-3">
                  <dt className="label">Members</dt>
                  <dd className="font-mono text-xs tabular-nums text-ink">{branch.memberCount}</dd>
                </div>
              ) : null}
            </dl>
          </Panel>
        ) : branchesLoading ? (
          <p className="font-mono text-xs text-ink-muted">Loading…</p>
        ) : (
          <p className="font-mono text-xs text-ink-muted">Perimeter not found.</p>
        )}

        {/* Groups */}
        <div id="groups">
        <Panel as="section" className="overflow-hidden">
          <PanelHeader>Groups</PanelHeader>
          {!branch?.registrar ? (
            <p className="px-4 py-8 text-center text-sm text-ink-muted">No registrar published — groups cannot be read.</p>
          ) : groupsLoading ? (
            <p className="px-4 py-8 text-center font-mono text-xs text-ink-muted">reading…</p>
          ) : groups.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-ink-muted">No groups defined yet.</p>
          ) : (
            <ul className="divide-y divide-rule">
              {groups.map((g) => {
                const enforcerGroup = (enforcerGroups ?? []).find((eg) => eg.name === g.name) ?? null;
                return (
                  <li key={g.id} className="px-4 py-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <span className="font-mono text-sm text-ink">{g.name}</span>
                        <div className="mt-1 flex flex-wrap gap-2 font-mono text-[0.6875rem] text-ink-muted">
                          {g.openToOnboarders ? <Tag>open to onboarders</Tag> : <Tag>restricted</Tag>}
                          {g.canOnboard ? <Tag>may onboard</Tag> : null}
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        onClick={() => setSettingsTarget({ group: g, enforcerGroup })}
                      >
                        Settings
                      </Button>
                    </div>
                    {g.entitlements.length > 0 ? (
                      <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                        {g.entitlements.map((e) => (
                          <div key={e.key} className="flex items-baseline gap-1.5">
                            <dt className="font-mono text-[0.6875rem] text-ink-muted">{e.key}</dt>
                            <dd className="font-mono text-[0.6875rem] text-ink-80">{e.value}</dd>
                          </div>
                        ))}
                      </dl>
                    ) : (
                      <p className="mt-1 text-xs text-ink-muted">No entitlements published.</p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
        </div>

        {/* Members */}
        <div id="members">
        <Panel as="section" className="overflow-hidden">
          <PanelHeader
            right={
              source ? (
                <span className="font-mono text-[0.6875rem] uppercase tracking-[0.1em] text-ink-muted">
                  {source === "indexer"
                    ? `ens indexer · block ${indexedBlock ?? "?"}`
                    : "direct chain reads"}
                  {stale ? " · stale" : ""}
                </span>
              ) : null
            }
          >
            Members
          </PanelHeader>
          {membersLoading ? (
            <p className="px-4 py-8 text-center font-mono text-xs text-ink-muted">reading…</p>
          ) : membersError ? (
            <p className="px-4 py-8 text-center text-sm text-ink-muted">Could not read members.</p>
          ) : !memberships || memberships.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-ink-muted">No members in this perimeter.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] border-collapse text-left">
                <thead>
                  <tr className="border-b border-rule">
                    {["Badge", "Name", "Wallet", "Role", "Entitlements"].map((h) => (
                      <th key={h} className="label px-4 py-2.5 font-normal">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-rule">
                  {memberships.map((m) => (
                    <tr key={m.name} className="hover:bg-ink/3">
                      <td className="px-4 py-3 font-mono text-xs text-ink">{m.label}</td>
                      <td className="px-4 py-3 font-mono text-xs text-ink-muted">{m.name}</td>
                      <td className="px-4 py-3 font-mono text-xs text-ink-muted">
                        {m.owner.slice(0, 6)}…{m.owner.slice(-4)}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-ink">{m.role}</td>
                      <td className="px-4 py-3">
                        {Object.keys(m.entitlements).length > 0 ? (
                          <dl className="flex flex-wrap gap-x-3 gap-y-0.5">
                            {Object.entries(m.entitlements).map(([k, v]) => (
                              <div key={k} className="flex items-baseline gap-1">
                                <dt className="font-mono text-[0.6875rem] text-ink-muted">{k}</dt>
                                <dd className="font-mono text-[0.6875rem] text-ink-80">{v}</dd>
                              </div>
                            ))}
                          </dl>
                        ) : (
                          <span className="font-mono text-[0.6875rem] text-ink-faint">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
        </div>
      </div>

      {settingsTarget && branch?.registrar && org ? (
        <GroupSettingsModal
          group={settingsTarget.group}
          enforcerGroup={settingsTarget.enforcerGroup}
          registrar={branch.registrar as Address}
          org={org}
          resources={resources ?? []}
          onClose={() => setSettingsTarget(null)}
          onSaved={() => { void mutateGroups(); setSettingsTarget(null); }}
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

function GroupSettingsModal({
  group, enforcerGroup, registrar, org, resources, onClose, onSaved,
}: {
  group: RoleInfo; enforcerGroup: Group | null; registrar: Address; org: string;
  resources: Resource[]; onClose: () => void; onSaved: () => void;
}) {
  const [tab, setTab] = useState<"settings" | "access">("settings");
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <button type="button" aria-label="Close" onClick={onClose}
        className="absolute inset-0 cursor-default bg-ink/20" />
      <div role="dialog" aria-modal="true" aria-label={`Group settings — ${group.name}`}
        className="relative w-full max-w-[520px] max-h-[90vh] overflow-y-auto rounded-sharp border border-rule bg-paper p-5">
        <p className="label">Group settings</p>
        <h2 className="mt-1 font-mono text-sm text-ink">{group.name}</h2>
        <div className="mt-4 flex gap-1 border-b border-rule">
          {(["settings", "access"] as const).map((t) => (
            <button key={t} type="button" onClick={() => setTab(t)}
              className={["px-3 py-1.5 font-mono text-[0.6875rem] uppercase tracking-[0.1em] border-b-2 -mb-px transition-colors",
                tab === t ? "border-ink text-ink" : "border-transparent text-ink-muted hover:text-ink"].join(" ")}>
              {t}
            </button>
          ))}
        </div>
        <div className="mt-4">
          {tab === "settings" ? (
            <NetworkSpeedTab group={group} registrar={registrar} org={org} onSaved={onSaved} />
          ) : (
            <AccessTab enforcerGroup={enforcerGroup} resources={resources} />
          )}
        </div>
        <div className="mt-5"><Button variant="ghost" onClick={onClose}>Close</Button></div>
      </div>
    </div>
  );
}

function NetworkSpeedTab({ group, registrar, org, onSaved }: {
  group: RoleInfo; registrar: Address; org: string; onSaved: () => void;
}) {
  const writes = useEnsWrites();
  const { address } = useAccount();
  const [download, setDownload] = useState(group.entitlements.find((e) => e.key === "wifi.rate")?.value ?? "");
  const [upload, setUpload] = useState(group.entitlements.find((e) => e.key === "wifi.ceil")?.value ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const valid = [download, upload].every((v) => v.trim() === "" || /^\d+(\.\d+)?$/.test(v.trim()));

  async function save() {
    if (!address) return;
    setBusy(true); setMessage(null);
    try {
      const existing = group.entitlements.filter((e) => e.key !== "wifi.rate" && e.key !== "wifi.ceil");
      const updated = [...existing];
      if (download.trim()) updated.push({ key: "wifi.rate", value: download.trim() });
      if (upload.trim()) updated.push({ key: "wifi.ceil", value: upload.trim() });
      const result = await writes.defineGroup({ registrar, name: group.name, canOnboard: group.canOnboard, openToOnboarders: group.openToOnboarders, editableKeys: [], entitlements: updated });
      if (!result) throw new Error(writes.error ?? "transaction did not go through");
      await fetch("/api/ens/mirror", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "group", org, registrar, name: group.name }) });
      setMessage({ ok: true, text: "Speed limits saved." });
      onSaved();
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : "failed" });
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs leading-relaxed text-ink-muted">Speed limits as ENS entitlements. Leave empty for unlimited.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <SpeedField label="Download (Mbps)" value={download} onChange={setDownload} />
        <SpeedField label="Upload (Mbps)" value={upload} onChange={setUpload} />
      </div>
      {message ? <p className="text-xs" style={{ color: message.ok ? "var(--signal)" : "var(--alert)" }} role="status">{message.text}</p> : null}
      <Button variant="outline" onClick={() => { void save(); }} disabled={!valid || busy || !address}>{busy ? "Signing…" : "Save speed limits"}</Button>
    </div>
  );
}

function SpeedField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="block text-[0.6875rem] text-ink-muted">{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ""))}
        inputMode="decimal" placeholder="unlimited"
        className="mt-1 h-9 w-full rounded-sharp border border-rule bg-paper px-2 font-mono text-xs tabular-nums text-ink placeholder:text-ink-faint" />
    </label>
  );
}

function AccessTab({ enforcerGroup, resources }: { enforcerGroup: Group | null; resources: Resource[] }) {
  if (!enforcerGroup) return <p className="text-sm text-ink-muted">Not mirrored to enforcer yet. Onboard a member first or save speed limits.</p>;
  if (resources.length === 0) return <p className="text-sm text-ink-muted">No resources configured.</p>;
  return (
    <div className="space-y-4">
      <p className="text-xs leading-relaxed text-ink-muted">Daily request caps. Leave empty for unlimited.</p>
      {resources.map((r) => <ResourceCaps key={r.id} group={enforcerGroup} resource={r} />)}
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

  useSWR<Limits>(`group-limits:${group.id}:${resource.id}`, async () => {
    try { return await api.get<Limits>(`groups/${group.id}/limits/${resource.id}`); }
    catch (e) {
      if (e && typeof e === "object" && "status" in e && (e as { status: number }).status === 404)
        return { per_device_per_day: null, group_per_day: null, per_ens_per_day: null };
      throw e;
    }
  }, {
    onSuccess(data) {
      if (!loaded) {
        setPerDevice(data.per_device_per_day !== null ? String(data.per_device_per_day) : "");
        setPerGroup(data.group_per_day !== null ? String(data.group_per_day) : "");
        setPerEns(data.per_ens_per_day !== null ? String(data.per_ens_per_day) : "");
        setLoaded(true);
      }
    },
  });

  const valid = [perDevice, perGroup, perEns].every((v) => v.trim() === "" || /^\d+$/.test(v.trim()));

  async function save() {
    setBusy(true); setMessage(null); setSaved(false);
    try {
      const limits: Limits = {
        per_device_per_day: perDevice.trim() ? Number(perDevice) : null,
        group_per_day: perGroup.trim() ? Number(perGroup) : null,
        per_ens_per_day: perEns.trim() ? Number(perEns) : null,
      };
      if (!limits.per_device_per_day && !limits.group_per_day && !limits.per_ens_per_day) await revokeAccess(group.id, resource.id);
      else await grantAccess(group.id, resource.id, limits);
      setSaved(true);
    } catch (e) { setMessage(e instanceof Error ? e.message : "failed"); }
    finally { setBusy(false); }
  }

  return (
    <div className="rounded-sharp border border-rule px-4 py-3">
      <p className="font-mono text-xs text-ink">{resource.slug}{!resource.enabled ? <span className="ml-2 text-ink-muted">(disabled)</span> : null}</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <CapField label="Per device / day" value={perDevice} onChange={setPerDevice} />
        <CapField label="Whole group / day" value={perGroup} onChange={setPerGroup} />
        <CapField label="Per ENS / day" value={perEns} onChange={setPerEns} />
      </div>
      {message ? <p className="mt-2 text-xs" style={{ color: "var(--alert)" }} role="status">{message}</p>
        : saved ? <p className="mt-2 font-mono text-xs text-ink-muted" role="status">saved</p> : null}
      <div className="mt-3"><Button variant="outline" onClick={save} disabled={!valid || busy || !loaded}>{busy ? "Saving…" : "Save caps"}</Button></div>
    </div>
  );
}

function CapField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="block text-[0.6875rem] text-ink-muted">{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value.replace(/[^0-9]/g, ""))}
        inputMode="numeric" placeholder="unlimited"
        className="mt-1 h-9 w-full rounded-sharp border border-rule bg-paper px-2 font-mono text-xs tabular-nums text-ink placeholder:text-ink-faint" />
    </label>
  );
}
