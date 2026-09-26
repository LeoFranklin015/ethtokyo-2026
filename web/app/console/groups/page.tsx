"use client";

import useSWR, { useSWRConfig } from "swr";
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
import { useEnsWrites } from "@/lib/ens/useEnsWrites";
import { useAccount } from "wagmi";
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

type SettingsTarget = { group: RoleInfo; enforcerGroup: Group | null };

/**
 * Groups — the categories people are onboarded into.
 *
 * Read from the branch registrar rather than from config, because a group is on-chain data: an
 * organization can invent one the contract never heard of and it appears here immediately.
 */
export default function GroupsPage() {
  const org = useOrg();
  const { mutate: globalMutate } = useSWRConfig();
  const { branches, isLoading: branchesLoading } = useEnsBranches(org);
  const withRegistrar = (branches ?? []).filter((b) => b.registrar);
  const [selected, setSelected] = useState<string>("");
  const registrar = selected || withRegistrar[0]?.registrar || "";
  const [settingsTarget, setSettingsTarget] = useState<SettingsTarget | null>(null);
  const [showCreatePerimeter, setShowCreatePerimeter] = useState(false);
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
        actions={
          <Button variant="outline" onClick={() => setShowCreatePerimeter(true)}>
            Create perimeter
          </Button>
        }
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
                    <Button
                      variant="ghost"
                      onClick={() => setSettingsTarget({ group: g, enforcerGroup })}
                    >
                      Settings
                    </Button>
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

      {settingsTarget ? (
        <GroupSettingsModal
          group={settingsTarget.group}
          enforcerGroup={settingsTarget.enforcerGroup}
          registrar={registrar as Address}
          org={org}
          resources={resources ?? []}
          onClose={() => setSettingsTarget(null)}
          onSaved={() => { mutate(); setSettingsTarget(null); }}
        />
      ) : null}

      {showCreatePerimeter && org ? (
        <CreatePerimeterModal
          org={org}
          onClose={() => setShowCreatePerimeter(false)}
          onCreated={() => {
            setShowCreatePerimeter(false);
            void globalMutate(`ens-branches:${org}`);
          }}
        />
      ) : null}
    </>
  );
}

function CreatePerimeterModal({
  org,
  onClose,
  onCreated,
}: {
  org: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { address } = useAccount();
  const writes = useEnsWrites();
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch the org's branchFactory address from the server.
  const { data: orgData } = useSWR<{
    organization: { branchFactory: string } | null;
  }>(
    `org-meta:${org}`,
    async () => {
      const r = await fetch(`/api/ens/org?name=${encodeURIComponent(org)}`);
      if (!r.ok) throw new Error("could not read org");
      return r.json();
    },
  );
  const factory = orgData?.organization?.branchFactory ?? null;

  const clean = label.trim().toLowerCase();
  const validLabel = /^[a-z0-9-]{1,32}$/.test(clean);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!factory || !address || !validLabel) return;
    setBusy(true);
    setError(null);
    try {
      const expiry = BigInt(Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60);
      const created = await writes.createBranch(
        clean,
        expiry,
        address as Address,
        factory as Address,
        org,
      );
      if (!created) throw new Error(writes.error ?? "the transaction did not go through");
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }

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
        aria-label="Create perimeter"
        className="relative w-full max-w-[440px] rounded-sharp border border-rule bg-paper p-5"
      >
        <p className="label">New perimeter</p>
        <h2 className="mt-1 font-mono text-sm text-ink">{org}.eth</h2>
        <p className="mt-2 text-xs leading-relaxed text-ink-muted">
          A perimeter is a branch registry. Give it a short identifier — members will be onboarded
          under it as <span className="font-mono">&lt;badge&gt;.&lt;name&gt;.{org}.eth</span>.
        </p>

        <form onSubmit={(e) => { void submit(e); }} className="mt-4 space-y-4">
          <label className="block">
            <span className="label">Perimeter name</span>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. tokyo"
              autoComplete="off"
              spellCheck={false}
              autoFocus
              className="mt-2 h-11 w-full rounded-sharp border border-rule bg-paper px-3 font-mono text-xs text-ink placeholder:text-ink-faint"
            />
            {label && !validLabel ? (
              <span className="mt-1 block text-xs" style={{ color: "var(--alert)" }}>
                Lowercase letters, digits and hyphens only, 1–32 characters.
              </span>
            ) : label && validLabel ? (
              <span className="mt-1 block font-mono text-xs text-ink-muted">
                {clean}.{org}.eth
              </span>
            ) : null}
          </label>

          {error ? (
            <p className="text-xs" style={{ color: "var(--alert)" }} role="status">
              {error}
            </p>
          ) : null}

          {!address ? (
            <p className="text-xs text-ink-muted">Connect a wallet to sign the transaction.</p>
          ) : !factory ? (
            <p className="text-xs text-ink-muted">Reading org contracts…</p>
          ) : null}

          <div className="flex gap-2">
            <Button
              type="submit"
              variant="outline"
              disabled={busy || !validLabel || !factory || !address}
            >
              {busy ? "Creating…" : "Create"}
            </Button>
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
          </div>
        </form>
      </div>
    </div>
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
 * Group settings modal with two tabs:
 *   Settings — network speed limits (ENS entitlements wifi.rate / wifi.ceil)
 *   Access   — daily resource caps per group via the enforcer grant API
 */
function GroupSettingsModal({
  group,
  enforcerGroup,
  registrar,
  org,
  resources,
  onClose,
  onSaved,
}: {
  group: RoleInfo;
  enforcerGroup: Group | null;
  registrar: Address;
  org: string;
  resources: Resource[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [tab, setTab] = useState<"settings" | "access">("settings");

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
        aria-label={`Group settings — ${group.name}`}
        className="relative w-full max-w-[520px] max-h-[90vh] overflow-y-auto rounded-sharp border border-rule bg-paper p-5"
      >
        <p className="label">Group settings</p>
        <h2 className="mt-1 font-mono text-sm text-ink">{group.name}</h2>

        <div className="mt-4 flex gap-1 border-b border-rule">
          {(["settings", "access"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={[
                "px-3 py-1.5 font-mono text-[0.6875rem] uppercase tracking-[0.1em] border-b-2 -mb-px transition-colors",
                tab === t
                  ? "border-ink text-ink"
                  : "border-transparent text-ink-muted hover:text-ink",
              ].join(" ")}
            >
              {t}
            </button>
          ))}
        </div>

        <div className="mt-4">
          {tab === "settings" ? (
            <NetworkSpeedTab
              group={group}
              registrar={registrar}
              org={org}
              onSaved={onSaved}
            />
          ) : (
            <AccessTab enforcerGroup={enforcerGroup} resources={resources} />
          )}
        </div>

        <div className="mt-5">
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Network speed limits written as ENS entitlements on the group's role.
 * wifi.rate = download (Mbps), wifi.ceil = upload ceiling (Mbps).
 */
function NetworkSpeedTab({
  group,
  registrar,
  org,
  onSaved,
}: {
  group: RoleInfo;
  registrar: Address;
  org: string;
  onSaved: () => void;
}) {
  const writes = useEnsWrites();
  const [download, setDownload] = useState(
    group.entitlements.find((e) => e.key === "wifi.rate")?.value ?? "",
  );
  const [upload, setUpload] = useState(
    group.entitlements.find((e) => e.key === "wifi.ceil")?.value ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const valid = [download, upload].every(
    (v) => v.trim() === "" || /^\d+(\.\d+)?$/.test(v.trim()),
  );

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const existing = group.entitlements.filter(
        (e) => e.key !== "wifi.rate" && e.key !== "wifi.ceil",
      );
      const updated = [...existing];
      if (download.trim()) updated.push({ key: "wifi.rate", value: download.trim() });
      if (upload.trim()) updated.push({ key: "wifi.ceil", value: upload.trim() });

      const result = await writes.defineGroup({
        registrar,
        name: group.name,
        canOnboard: group.canOnboard,
        openToOnboarders: group.openToOnboarders,
        editableKeys: [],
        entitlements: updated,
      });
      if (!result) throw new Error(writes.error ?? "transaction did not go through");

      // Re-mirror so the enforcer picks up updated entitlements.
      await fetch("/api/ens/mirror", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "group", org, registrar, name: group.name }),
      });

      setMessage({ ok: true, text: "Speed limits saved." });
      onSaved();
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : "failed" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs leading-relaxed text-ink-muted">
        Speed limits published as ENS entitlements on this group. Leave empty for unlimited.
        Changes require a wallet signature and take effect on the next admission.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <SpeedField label="Download (Mbps)" value={download} onChange={setDownload} />
        <SpeedField label="Upload (Mbps)" value={upload} onChange={setUpload} />
      </div>
      {message ? (
        <p
          className="text-xs"
          style={{ color: message.ok ? "var(--signal)" : "var(--alert)" }}
          role="status"
        >
          {message.text}
        </p>
      ) : null}
      <Button variant="outline" onClick={() => { void save(); }} disabled={!valid || busy}>
        {busy ? "Signing…" : "Save speed limits"}
      </Button>
    </div>
  );
}

function SpeedField({
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
        onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ""))}
        inputMode="decimal"
        placeholder="unlimited"
        className="mt-1 h-9 w-full rounded-sharp border border-rule bg-paper px-2 font-mono text-xs tabular-nums text-ink placeholder:text-ink-faint"
      />
    </label>
  );
}

/**
 * Access tab — daily request caps per resource via the enforcer grant API.
 */
function AccessTab({
  enforcerGroup,
  resources,
}: {
  enforcerGroup: Group | null;
  resources: Resource[];
}) {
  if (!enforcerGroup) {
    return (
      <p className="text-sm text-ink-muted">
        This group has not been mirrored to the enforcer yet. Onboard a member first, or save
        speed limits — both actions sync the group.
      </p>
    );
  }
  if (resources.length === 0) {
    return (
      <p className="text-sm text-ink-muted">
        No resources configured. Add one under{" "}
        <a href="/console/resources" className="underline decoration-rule underline-offset-2">
          Resources
        </a>
        .
      </p>
    );
  }
  return (
    <div className="space-y-4">
      <p className="text-xs leading-relaxed text-ink-muted">
        Daily request caps for this group. Leave empty for unlimited. Changes take effect
        immediately — the proxy reads limits on every request.
      </p>
      {resources.map((r) => (
        <ResourceCaps key={r.id} group={enforcerGroup} resource={r} />
      ))}
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
