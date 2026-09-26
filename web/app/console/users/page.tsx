"use client";

import { useState } from "react";
import { PageHeader } from "@/components/console/PageHeader";
import { Button } from "@/components/ui/Button";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { ApiError, api } from "@/lib/api";
import { NoOrgSelected } from "@/components/console/OrgPicker";
import { useOrg } from "@/lib/hooks/useOrg";
import {
  useEnforcerGroups,
  useEnforcerUsers,
  type Group,
  type User,
} from "@/lib/hooks/useEnforcer";
import { UserDetailPanel } from "@/components/console/UserDetailPanel";

/**
 * The enforcer's own rows, as rows.
 *
 * Deliberately not the People page. That one joins ENS to the enforcer and answers "who is a
 * member, and does the door agree"; this one answers "what is actually in the enforcer's
 * database", including the rows that have no ENS name at all — a contractor added by hand, a
 * leftover from a branch that no longer exists — which a join on ENS name cannot show and which
 * only this page can create, move between groups or delete.
 *
 * Scoped to the organization in the URL. One enforcer can hold several organizations' people,
 * and listing all of them under whichever name the console happens to be showing is how this
 * page came to display another organization's members as if they were yours.
 */
export default function UsersPage() {
  const org = useOrg();
  const { groups } = useEnforcerGroups(org);
  const [groupFilter, setGroupFilter] = useState("");
  const [disabledFilter, setDisabledFilter] = useState("");
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const { users, total, error, isLoading, reload } = useEnforcerUsers(org, {
    group_id: groupFilter || undefined,
    disabled: disabledFilter || undefined,
    offset,
  });

  const signedOut = error instanceof ApiError && error.isUnauthenticated;
  const shown = users ?? [];

  if (!org) {
    return (
      <>
        <PageHeader eyebrow="Enforcer" title="Users" />
        <div className="px-4 py-8 sm:px-6">
          <NoOrgSelected />
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="Enforcer"
        title="Users"
        meta={
          total === undefined
            ? `People in ${org}.eth on this perimeter`
            : `${total} in ${org}.eth on this perimeter`
        }
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
                : `Nobody from ${org}.eth yet. Members admitted under a perimeter of this organization appear here automatically.`}
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

function groupName(groups: Group[] | undefined, user: User): string {
  if (!user.default_group_id) return "no group";
  return groups?.find((g) => g.id === user.default_group_id)?.name ?? "—";
}

function generatedPassword(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
