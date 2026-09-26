"use client";

import { useState } from "react";
import { PageHeader } from "@/components/console/PageHeader";
import { Button } from "@/components/ui/Button";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { ApiError } from "@/lib/api";
import {
  grantAccess,
  revokeAccess,
  useAccessMatrix,
  type Group,
  type Resource,
} from "@/lib/hooks/useEnforcer";

/**
 * Who can reach what.
 *
 * Access is granted to a group, never to a person: the proxy denies any request whose group has
 * no row for that resource, and there is no per-user override anywhere in the system. So this is
 * the whole of the policy, and it is a matrix because the relationship is otherwise invisible —
 * it lives in a join table, and finding it out means opening every group in turn.
 */
export default function AccessPage() {
  const { groups, resources, grants, error, isLoading, reload } = useAccessMatrix();
  const [editing, setEditing] = useState<{ group: Group; resource: Resource } | null>(null);

  const signedOut = error instanceof ApiError && error.isUnauthenticated;

  return (
    <>
      <PageHeader
        eyebrow="Enforcer"
        title="Access"
        meta="Which group may reach which resource"
      />

      <div className="space-y-6 px-4 py-6 sm:px-6">
        <p className="max-w-[62ch] text-sm leading-relaxed text-ink-muted">
          A cell is a grant. Filled means that group&rsquo;s members can reach that upstream, with
          the daily caps shown; empty means every request is denied. There is no per-person switch —
          to change what somebody can reach, change which group they are in.
        </p>

        <Panel as="section">
          <PanelHeader
            right={
              groups && resources ? (
                <span className="font-mono text-[0.6875rem] text-ink-muted">
                  {groups.length} × {resources.length}
                </span>
              ) : null
            }
          >
            Groups × resources
          </PanelHeader>

          {signedOut ? (
            <p className="px-4 py-8 text-xs leading-relaxed" style={{ color: "var(--alert)" }} role="status">
              This wallet has not proved it owns the organization, so nothing here can be
              changed.{" "}
              <a href="/console/signin" className="underline decoration-rule underline-offset-2">
                Sign a message to prove it
              </a>
              .
            </p>
          ) : error ? (
            <p className="px-4 py-8 text-xs leading-relaxed" style={{ color: "var(--alert)" }} role="status">
              The enforcer did not answer. This is a read failure, not an empty policy — no cell
              below should be taken to mean &ldquo;no access&rdquo;.
            </p>
          ) : isLoading ? (
            <p className="px-4 py-8 font-mono text-xs text-ink-muted">Reading…</p>
          ) : (groups ?? []).length === 0 || (resources ?? []).length === 0 ? (
            <p className="px-4 py-8 text-sm text-ink-muted">
              {(resources ?? []).length === 0
                ? "No resources yet. Add one under Resources, then grant groups access to it."
                : "No groups yet. Create one before granting anything."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-rule">
                    <th scope="col" className="label sticky left-0 z-10 bg-paper-raise px-4 py-2.5">
                      Group
                    </th>
                    {(resources ?? []).map((r) => (
                      <th key={r.id} scope="col" className="px-3 py-2.5">
                        <span className="block font-mono text-[0.6875rem] text-ink">{r.slug}</span>
                        <span className="block font-mono text-[0.625rem] text-ink-muted">
                          {r.enabled ? "enabled" : "disabled"}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-rule">
                  {(groups ?? []).map((g) => (
                    <tr key={g.id}>
                      <th scope="row" className="sticky left-0 z-10 bg-paper-raise px-4 py-2.5 text-left font-normal">
                        <span className="block font-mono text-xs text-ink">{g.name}</span>
                        <span className="block font-mono text-[0.625rem] text-ink-muted">
                          {g.network_tier} · {g.member_count} member{g.member_count === 1 ? "" : "s"}
                        </span>
                      </th>
                      {(resources ?? []).map((r) => {
                        const grant = grants.get(`${g.id}:${r.id}`);
                        return (
                          <td key={r.id} className="px-3 py-2.5">
                            <button
                              type="button"
                              onClick={() => setEditing({ group: g, resource: r })}
                              aria-label={
                                grant
                                  ? `Edit ${g.name}'s access to ${r.slug}`
                                  : `Grant ${g.name} access to ${r.slug}`
                              }
                              className={`min-h-9 w-full rounded-sharp border px-2 py-1 text-left font-mono text-[0.6875rem] transition-colors ${
                                grant
                                  ? "border-rule bg-ink/5 text-ink hover:border-ink"
                                  : "border-dashed border-rule text-ink-faint hover:border-ink hover:text-ink"
                              }`}
                            >
                              {grant
                                ? `${cap(grant.per_device_per_day)} / ${cap(grant.group_per_day)}`
                                : "no access"}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="border-t border-rule px-4 py-3 font-mono text-[0.625rem] text-ink-muted">
            per device / whole group per day · — is unlimited
          </p>
        </Panel>

        <p className="max-w-[62ch] text-xs leading-relaxed text-ink-muted">
          These groups, users and resources belong to one branch enforcer, which has no
          organization column — everything on this screen is that deployment&rsquo;s, not one
          organization&rsquo;s. The chain decides which group somebody is in; this decides what
          that group can reach.
        </p>
      </div>

      {editing ? (
        <GrantDialog
          group={editing.group}
          resource={editing.resource}
          existing={grants.get(`${editing.group.id}:${editing.resource.id}`) ?? null}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await reload();
          }}
        />
      ) : null}
    </>
  );
}

function GrantDialog({
  group,
  resource,
  existing,
  onClose,
  onSaved,
}: {
  group: Group;
  resource: Resource;
  existing: { per_device_per_day: number | null; group_per_day: number | null } | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [perDevice, setPerDevice] = useState(text(existing?.per_device_per_day ?? null));
  const [perGroup, setPerGroup] = useState(text(existing?.group_per_day ?? null));
  const [perEns, setPerEns] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const valid = [perDevice, perGroup, perEns].every((v) => v.trim() === "" || /^\d+$/.test(v.trim()));

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      // All three, always. `PUT` replaces the row, so a field left out is not "unchanged" — it is
      // set to unlimited, and the per-ENS one cannot be read back to notice.
      await grantAccess(group.id, resource.id, {
        per_device_per_day: num(perDevice),
        group_per_day: num(perGroup),
        per_ens_per_day: num(perEns),
      });
      onSaved();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "failed");
      setBusy(false);
    }
  }

  async function revoke() {
    setBusy(true);
    setMessage(null);
    try {
      await revokeAccess(group.id, resource.id);
      onSaved();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "failed");
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
        aria-label={`${group.name} → ${resource.slug}`}
        className="relative w-full max-w-[420px] rounded-sharp border border-rule bg-paper p-5"
      >
        <p className="label">{existing ? "Access" : "Grant access"}</p>
        <h2 className="mt-2 font-mono text-sm text-ink">
          {group.name} <span className="text-ink-muted">→</span> {resource.slug}
        </h2>
        <p className="mt-2 text-xs leading-relaxed text-ink-muted">
          Leave a field empty for unlimited. Every member of this group gets these caps.
        </p>

        <div className="mt-4 space-y-3">
          <Cap label="Per device, per day" hint="One IP address." value={perDevice} onChange={setPerDevice} />
          <Cap label="Whole group, per day" hint="Shared across everyone in it." value={perGroup} onChange={setPerGroup} />
          <Cap
            label="Per ENS name, per day"
            hint={
              existing
                ? "Set, but the enforcer does not return it — whatever you type here replaces it."
                : "One person across all their devices. Requires them to have signed in with a name."
            }
            value={perEns}
            onChange={setPerEns}
          />
        </div>

        {message ? (
          <p className="mt-3 text-xs leading-relaxed" style={{ color: "var(--alert)" }} role="status">
            {message}
          </p>
        ) : null}

        <div className="mt-5 flex flex-wrap gap-2">
          <Button variant="solid" onClick={save} disabled={!valid || busy}>
            {busy ? "Saving…" : existing ? "Save caps" : "Grant access"}
          </Button>
          {existing ? (
            <Button variant="ghost" onClick={revoke} disabled={busy}>
              Revoke
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

function Cap({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/[^0-9]/g, ""))}
        inputMode="numeric"
        placeholder="unlimited"
        className="mt-1.5 h-11 w-full rounded-sharp border border-rule bg-paper px-3 font-mono text-sm tabular-nums text-ink placeholder:text-ink-faint"
      />
      <span className="mt-1 block text-xs leading-relaxed text-ink-muted">{hint}</span>
    </label>
  );
}

const cap = (n: number | null) => (n === null ? "—" : String(n));
const text = (n: number | null) => (n === null ? "" : String(n));
const num = (v: string) => (v.trim() === "" ? null : Number(v.trim()));
