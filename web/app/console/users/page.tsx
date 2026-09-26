"use client";

import { useState } from "react";
import { PageHeader } from "@/components/console/PageHeader";
import { Button } from "@/components/ui/Button";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { ApiError, api } from "@/lib/api";
import {
  useEnforcerGroups,
  useEnforcerUsers,
  useGroupDetail,
  useUserDetail,
  type Group,
  type User,
} from "@/lib/hooks/useEnforcer";

/**
 * People the enforcer knows about.
 *
 * What somebody can reach is never stored against them — it comes entirely from their group. The
 * detail panel therefore shows their access as *their group's* access, labelled as such, so that
 * nobody goes looking for a per-person switch that does not exist.
 */
export default function UsersPage() {
  const { groups } = useEnforcerGroups();
  const [groupFilter, setGroupFilter] = useState("");
  const [disabledFilter, setDisabledFilter] = useState("");
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const { users, total, error, isLoading, reload } = useEnforcerUsers({
    group_id: groupFilter || undefined,
    disabled: disabledFilter || undefined,
    offset,
  });

  const signedOut = error instanceof ApiError && error.isUnauthenticated;
  const shown = users ?? [];

  return (
    <>
      <PageHeader
        eyebrow="Enforcer"
        title="Users"
        meta={total === undefined ? "People on this branch" : `${total} on this branch`}
        actions={
          <Button variant="solid" onClick={() => setAdding((a) => !a)} disabled={!groups?.length}>
            {adding ? "Cancel" : "Add a user"}
          </Button>
        }
      />

      <div className="space-y-6 px-4 py-6 sm:px-6">
        {adding && groups?.length ? (
          <CreateUser
            groups={groups}
            onDone={() => {
              setAdding(false);
              void reload();
            }}
          />
        ) : null}

        <Panel as="section">
          <PanelHeader
            right={
              <span className="flex flex-wrap items-center gap-2">
                <select
                  value={groupFilter}
                  onChange={(e) => {
                    setGroupFilter(e.target.value);
                    setOffset(0);
                  }}
                  aria-label="Filter by group"
                  className="h-9 rounded-sharp border border-rule bg-paper px-2 font-mono text-[0.6875rem] text-ink"
                >
                  <option value="">every group</option>
                  {(groups ?? []).map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
                <select
                  value={disabledFilter}
                  onChange={(e) => {
                    setDisabledFilter(e.target.value);
                    setOffset(0);
                  }}
                  aria-label="Filter by status"
                  className="h-9 rounded-sharp border border-rule bg-paper px-2 font-mono text-[0.6875rem] text-ink"
                >
                  <option value="">any status</option>
                  <option value="0">active only</option>
                  <option value="1">disabled only</option>
                </select>
              </span>
            }
          >
            People
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
              The enforcer did not answer. Nobody is listed rather than listing nobody.
            </p>
          ) : isLoading && !users ? (
            <p className="px-4 py-8 font-mono text-xs text-ink-muted">Reading…</p>
          ) : shown.length === 0 ? (
            <p className="px-4 py-8 text-sm text-ink-muted">
              {groupFilter || disabledFilter
                ? "Nobody matches those filters."
                : "Nobody yet. Members who sign in with an ENS name appear here automatically."}
            </p>
          ) : (
            <ul className="divide-y divide-rule">
              {shown.map((u) => (
                <li key={u.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(u.id)}
                    className="flex w-full flex-wrap items-center justify-between gap-3 px-4 py-3 text-left hover:bg-ink/5"
                  >
                    <span className="min-w-0">
                      <span className="flex items-center gap-2">
                        <span
                          aria-hidden
                          className="size-1.5 shrink-0 rounded-full"
                          style={{ background: u.disabled ? "var(--ink-faint)" : "var(--signal)" }}
                        />
                        <span className="truncate font-mono text-sm text-ink">{u.username}</span>
                        {u.disabled ? (
                          <span className="shrink-0 font-mono text-[0.625rem] text-ink-muted">disabled</span>
                        ) : null}
                      </span>
                      <span className="mt-0.5 block truncate font-mono text-[0.6875rem] text-ink-muted">
                        {u.ens_name ?? "no ENS name"}
                        {u.wallet_address ? ` · ${u.wallet_address.slice(0, 6)}…${u.wallet_address.slice(-4)}` : ""}
                      </span>
                    </span>
                    <span className="shrink-0 font-mono text-[0.6875rem] text-ink-muted">
                      {groupName(groups, u)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {total !== undefined && total > 50 ? (
            <div className="flex items-center justify-between gap-3 border-t border-rule px-4 py-3">
              <span className="font-mono text-[0.625rem] text-ink-muted">
                {offset + 1}–{Math.min(offset + 50, total)} of {total}
              </span>
              <span className="flex gap-2">
                <Button variant="ghost" onClick={() => setOffset((o) => Math.max(0, o - 50))} disabled={offset === 0}>
                  Previous
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => setOffset((o) => o + 50)}
                  disabled={offset + 50 >= total}
                >
                  Next
                </Button>
              </span>
            </div>
          ) : null}
        </Panel>
      </div>

      {selected ? (
        <UserDetailPanel
          id={selected}
          groups={groups ?? []}
          onClose={() => setSelected(null)}
          onChanged={() => void reload()}
          onDeleted={() => {
            setSelected(null);
            void reload();
          }}
        />
      ) : null}
    </>
  );
}

function UserDetailPanel({
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
            Could not read this person.
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
                    <li key={slug} className="flex items-baseline justify-between gap-3 py-2">
                      <span className="truncate font-mono text-xs text-ink">{slug}</span>
                      <span className="shrink-0 font-mono text-[0.625rem] tabular-nums text-ink-muted">
                        {l.per_device_per_day ?? "—"} / {l.group_per_day ?? "—"} per day
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

function CreateUser({ groups, onDone }: { groups: Group[]; onDone: () => void }) {
  const [username, setUsername] = useState("");
  const [ensName, setEnsName] = useState("");
  const [wallet, setWallet] = useState("");
  const [groupId, setGroupId] = useState(groups[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const valid = username.trim().length > 0 && groupId;

  async function submit() {
    setBusy(true);
    setMessage(null);
    try {
      await api.post("users", {
        username: username.trim(),
        // The enforcer insists on a password even though members authenticate by signature and
        // nothing ever checks this one. Generating it beats asking an operator to invent a secret
        // that is never used.
        password: generatedPassword(),
        group_id: groupId,
        ens_name: ensName.trim() || null,
        wallet_address: wallet.trim() || null,
      });
      onDone();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel as="section">
      <PanelHeader>Add a user</PanelHeader>
      <div className="space-y-4 px-4 py-5">
        <p className="max-w-[54ch] text-xs leading-relaxed text-ink-muted">
          Only needed for somebody who is not joining through ENS — a member who signs in with a
          name is created automatically. No password is asked for because none is ever checked.
        </p>

        <label className="block">
          <span className="label">Username</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="off"
            className="mt-2 h-11 w-full rounded-sharp border border-rule bg-paper px-3 font-mono text-sm text-ink"
          />
        </label>

        <label className="block">
          <span className="label">ENS name</span>
          <input
            value={ensName}
            onChange={(e) => setEnsName(e.target.value)}
            placeholder="optional"
            autoComplete="off"
            className="mt-2 h-11 w-full rounded-sharp border border-rule bg-paper px-3 font-mono text-sm text-ink placeholder:text-ink-faint"
          />
        </label>

        <label className="block">
          <span className="label">Wallet</span>
          <input
            value={wallet}
            onChange={(e) => setWallet(e.target.value)}
            placeholder="optional"
            autoComplete="off"
            spellCheck={false}
            className="mt-2 h-11 w-full rounded-sharp border border-rule bg-paper px-3 font-mono text-xs text-ink placeholder:text-ink-faint"
          />
        </label>

        <label className="block">
          <span className="label">Group</span>
          <select
            value={groupId}
            onChange={(e) => setGroupId(e.target.value)}
            className="mt-2 h-11 w-full rounded-sharp border border-rule bg-paper px-2 font-mono text-xs text-ink"
          >
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name} · {g.network_tier}
              </option>
            ))}
          </select>
        </label>

        {message ? (
          <p className="text-xs leading-relaxed" style={{ color: "var(--alert)" }} role="status">
            {message}
          </p>
        ) : null}

        <Button variant="solid" onClick={submit} disabled={!valid || busy}>
          {busy ? "Adding…" : "Add user"}
        </Button>
      </div>
    </Panel>
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

function groupName(groups: Group[] | undefined, user: User): string {
  if (!user.default_group_id) return "no group";
  return groups?.find((g) => g.id === user.default_group_id)?.name ?? "—";
}

function generatedPassword(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
