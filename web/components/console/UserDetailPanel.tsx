"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { ApiError, api } from "@/lib/api";
import { useGroupDetail, useUserDetail, type Group } from "@/lib/hooks/useEnforcer";

/**
 * One enforcer row, in full.
 *
 * Shared by the enforcer's own list and by the People page, which reaches it for anybody the
 * enforcer knows. What somebody can reach is never stored against them — it comes entirely from
 * their group — so their access is shown as *their group's* access, labelled as such, and nobody
 * goes looking for a per-person switch that does not exist.
 */
export function UserDetailPanel({
  id,
  groups,
  onClose,
  onChanged,
  onDeleted,
}: {
  id: string;
  groups: Group[];
  onClose: () => void;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const { user, error, isLoading, reload } = useUserDetail(id);
  const { group: groupDetail } = useGroupDetail(user?.group?.id ?? null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function act(fn: () => Promise<unknown>, after: () => void = () => void reload()) {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      after();
      onChanged();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 cursor-default bg-ink/20" />
      <aside
        aria-label="User"
        className="relative flex w-full max-w-[420px] flex-col overflow-y-auto border-l border-rule bg-paper"
      >
        <div className="flex items-start justify-between gap-3 border-b border-rule px-5 py-4">
          <div className="min-w-0">
            <p className="label">User</p>
            <h2 className="mt-1 truncate font-mono text-sm text-ink">{user?.username ?? "…"}</h2>
          </div>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>

        {error ? (
          <p className="px-5 py-6 text-xs leading-relaxed" style={{ color: "var(--alert)" }} role="status">
            {error instanceof ApiError && error.isUnreachable
              ? "The enforcer did not answer, so this person could not be read."
              : "Could not read this person."}
          </p>
        ) : isLoading || !user ? (
          <p className="px-5 py-6 font-mono text-xs text-ink-muted">Reading…</p>
        ) : (
          <div className="space-y-6 px-5 py-5">
            <section>
              <p className="label">Identity</p>
              <dl className="mt-2 space-y-1">
                <Row term="ENS name" value={user.ens_name ?? "—"} />
                <Row term="Wallet" value={user.wallet_address ?? "—"} />
                <Row term="Joined" value={new Date(user.created_at * 1000).toLocaleDateString()} />
              </dl>
            </section>

            <section>
              <p className="label">Group</p>
              <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">
                This is the whole of their access. Moving them changes what they can reach.
              </p>
              <select
                value={user.group?.id ?? ""}
                disabled={busy}
                onChange={(e) => act(() => api.patch(`users/${id}`, { group_id: e.target.value }))}
                aria-label="Group"
                className="mt-2 h-11 w-full rounded-sharp border border-rule bg-paper px-2 font-mono text-xs text-ink"
              >
                {user.group ? null : <option value="">no group</option>}
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name} · {g.network_tier}
                  </option>
                ))}
              </select>
            </section>

            <section>
              <p className="label">What they can reach</p>
              <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">
                Because of {user.group?.name ?? "their group"}, not because of them.
              </p>
              {groupDetail === undefined ? (
                <p className="mt-2 font-mono text-xs text-ink-muted">reading…</p>
              ) : Object.keys(groupDetail.limits ?? {}).length === 0 ? (
                <p className="mt-2 text-sm text-ink-muted">
                  Nothing. That group has no resource grants, so every request is denied.
                </p>
              ) : (
                <ul className="mt-2 divide-y divide-rule border-y border-rule">
                  {Object.entries(groupDetail.limits).map(([slug, l]) => (
                    <li key={slug} className="py-2">
                      <span className="block truncate font-mono text-xs text-ink">{slug}</span>
                      <span className="mt-0.5 block font-mono text-[0.625rem] tabular-nums text-ink-muted">
                        {l.per_device_per_day ?? "—"} per device · {l.group_per_day ?? "—"} per
                        group · {l.per_ens_per_day ?? "—"} per person, each day
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-2">
                <a href="/console/access" className="font-mono text-[0.6875rem] text-ink-muted underline decoration-rule underline-offset-2 hover:text-ink">
                  Change it on the access matrix
                </a>
              </p>
            </section>

            <section>
              <p className="label">Today</p>
              {Object.keys(user.usage_today ?? {}).length === 0 ? (
                <p className="mt-2 text-sm text-ink-muted">
                  {user.active_session ? "Nothing used yet today." : "Not online, so nothing is counted."}
                </p>
              ) : (
                <ul className="mt-2 divide-y divide-rule border-y border-rule">
                  {Object.entries(user.usage_today).map(([slug, u]) => (
                    <li key={slug} className="flex items-baseline justify-between gap-3 py-2">
                      <span className="truncate font-mono text-xs text-ink">{slug}</span>
                      <span className="shrink-0 font-mono text-[0.625rem] tabular-nums text-ink-muted">
                        {u.used} / {u.limit ?? "—"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <p className="label">Session</p>
              {user.active_session ? (
                <>
                  <p className="mt-2 font-mono text-xs text-ink">
                    {user.active_session.ip}
                    <span className="text-ink-muted">
                      {" "}
                      since {new Date(user.active_session.logged_in_at * 1000).toLocaleTimeString()}
                    </span>
                  </p>
                  <Button
                    variant="outline"
                    className="mt-2"
                    disabled={busy}
                    onClick={() => act(() => api.post(`users/${id}/revoke`))}
                  >
                    End this session
                  </Button>
                  <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">
                    Drops the firewall rule too, so the device is off the network immediately.
                  </p>
                </>
              ) : (
                <p className="mt-2 text-sm text-ink-muted">Not online.</p>
              )}
            </section>

            <section className="border-t border-rule pt-5">
              <p className="label">Account</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => act(() => api.patch(`users/${id}`, { disabled: !user.disabled }))}
                >
                  {user.disabled ? "Re-enable" : "Disable"}
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => act(() => api.delete(`users/${id}`), onDeleted)}
                >
                  Delete
                </Button>
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">
                Disabling keeps their history; deleting does not.
              </p>
            </section>

            {message ? (
              <p className="text-xs leading-relaxed" style={{ color: "var(--alert)" }} role="status">
                {message}
              </p>
            ) : null}
          </div>
        )}
      </aside>
    </div>
  );
}

function Row({ term, value }: { term: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="shrink-0 font-mono text-[0.6875rem] text-ink-muted">{term}</dt>
      <dd className="truncate font-mono text-[0.6875rem] text-ink-80">{value}</dd>
    </div>
  );
}
