"use client";

import { useMemo, useState, useEffect, useRef } from "react";
import { PageHeader } from "@/components/console/PageHeader";
import { NoOrgSelected } from "@/components/console/OrgPicker";
import { OnboardForm } from "@/components/console/OnboardForm";
import { UserDetailPanel } from "@/components/console/UserDetailPanel";
import { Button } from "@/components/ui/Button";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { ApiError, api } from "@/lib/api";
import { useEnforcerGroups, useEnforcerUsers, type Group, type User } from "@/lib/hooks/useEnforcer";
import { useEnsBranches, useEnsMemberships } from "@/lib/hooks/useEns";
import { useOrg } from "@/lib/hooks/useOrg";
import { useSessions } from "@/lib/hooks/useSessions";
import { useUsers } from "@/lib/hooks/useUsers";

/**
 * One list of people, from the two places that disagree about them.
 *
 * A membership is an on-chain name minted by a branch registrar; that is the truth. The branch
 * enforcer's SQLite is a copy, written by `/api/ens/mirror` after it re-reads the chain, and it
 * is the copy the proxy and the captive portal consult at the door. When the copy is missing, a
 * legitimate member is refused and nothing else in this console says why — so the disagreement
 * is the column this page exists for.
 *
 * The two reads fail independently, and that is the trap this page is built around: an
 * unanswered chain read is not "nobody is a member", and an unreachable enforcer is not "nobody
 * is mirrored". A reconciliation state is therefore only ever computed when *both* sides have
 * actually answered. Otherwise the rows still render, from whichever side spoke, labelled as
 * one-sided — never as a disagreement we did not observe.
 */

type Standing = "both" | "chain-only" | "enforcer-only" | "unknown";

type Person = {
  /** The join key: the full `<id>.<branch>.<org>.eth`, exactly as `mirror.ts` writes `ens_name`. */
  key: string;
  ensName: string | null;
  /** Shown when the enforcer holds a row with no ENS name, which can never join to a membership. */
  username: string | null;
  branch: string | null;
  owner: string | null;
  chainRole: string | null;
  enforcerId: string | null;
  enforcerGroup: string | null;
  disabled: boolean;
  /** `null` means the session read did not answer — not that they are offline. */
  online: boolean | null;
  standing: Standing;
};

const COLUMNS = ["Person", "On chain", "Enforcer", "Network", "Standing", ""];

export default function PeoplePage() {
  const org = useOrg();

  const {
    memberships,
    error: chainError,
    isLoading: chainLoading,
    stale: chainStale,
    lag: chainLag,
    source: chainSource,
  } = useEnsMemberships(org);
  const { branches } = useEnsBranches(org);
  // `useUsers` rather than the paginated `useEnforcerUsers`: a join that only saw the first page
  // of the enforcer would report everybody after it as "not mirrored", which is exactly the
  // false alarm this page must not raise.
  const { data: usersData, error: enforcerError, mutate: reloadUsers } = useUsers(org);
  const { data: sessionsData, error: sessionsError } = useSessions(org, true);
  const { groups } = useEnforcerGroups(org);

  const [onlyDisagreements, setOnlyDisagreements] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [onboarding, setOnboarding] = useState(false);

  // Enforcer users panel (paginated, filterable — the raw enforcer view)
  const [userGroupFilter, setUserGroupFilter] = useState("");
  const [userDisabledFilter, setUserDisabledFilter] = useState("");
  const [userOffset, setUserOffset] = useState(0);
  const [addingUser, setAddingUser] = useState(false);
  const {
    users: enforcerUsers,
    total: enforcerTotal,
    error: enforcerUsersError,
    isLoading: enforcerUsersLoading,
    reload: reloadEnforcerUsers,
  } = useEnforcerUsers(org, {
    group_id: userGroupFilter || undefined,
    disabled: userDisabledFilter || undefined,
    offset: userOffset,
  });

  // "Answered" is stricter than "no error": SWR reports neither while the first request is in
  // flight, and a row must not be called one-sided before the other side has had its turn.
  //
  // A stale index does not count as an answer: an empty list from an index that stopped an hour
  // ago means "we do not know yet", not "there is nobody", and reading it as an answer is what
  // put `NOT ON CHAIN` beside a member who was registered, owned and perfectly valid on chain.
  //
  // `source: "chain"` is the exception, and it is not a weakening of that rule. Those rows were
  // each read back off the registry in this request, so they are an answer however far behind
  // the index happens to be — the index's age says nothing about them.
  const chainAnswered =
    !chainError && memberships !== undefined && (chainSource === "chain" || !chainStale);
  const enforcerAnswered = !enforcerError && usersData !== undefined;
  const sessionsAnswered = !sessionsError && sessionsData !== undefined;

  const people = useMemo(
    () =>
      reconcile({
        memberships: memberships ?? [],
        users: usersData?.users ?? [],
        sessions: sessionsData?.sessions ?? [],
        groups: groups ?? [],
        chainAnswered,
        enforcerAnswered,
        sessionsAnswered,
      }),
    [memberships, usersData, sessionsData, groups, chainAnswered, enforcerAnswered, sessionsAnswered],
  );

  const disagreeing = people.filter((p) => p.standing === "chain-only" || p.standing === "enforcer-only");
  const shown = onlyDisagreements ? disagreeing : people;

  const registrarFor = new Map((branches ?? []).map((b) => [b.name, b.registrar]));

  // Scraper profiles keyed by badge label (the first segment of their ENS name)
  const [scraperProfiles, setScraperProfiles] = useState<Record<string, { name: string | null; image: string | null }>>({});
  const fetchedLabels = useRef(new Set<string>());

  useEffect(() => {
    for (const p of shown) {
      const label = p.ensName?.split(".")[0];
      if (!label || fetchedLabels.current.has(label)) continue;
      fetchedLabels.current.add(label);
      const badgeUrl = `https://ethglob.al/${label}`;
      fetch(`/api/portal/scrape?url=${encodeURIComponent(badgeUrl)}`)
        .then((r) => r.ok ? r.json() : null)
        .then((body: { name?: string | null; image?: string | null } | null) => {
          if (!body) return;
          setScraperProfiles((prev) => ({ ...prev, [label]: { name: body.name ?? null, image: body.image ?? null } }));
        })
        .catch(() => undefined);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);

  /** Retrying goes through `/api/ens/mirror`, which re-reads the chain rather than trusting us. */
  async function retryMirror(person: Person) {
    const registrar = person.branch ? registrarFor.get(person.branch) : null;
    if (!registrar || !person.owner || !person.ensName) return;
    setBusy(person.key);
    setNotes((n) => ({ ...n, [person.key]: { ok: true, text: "asking the chain…" } }));
    try {
      const res = await fetch("/api/ens/mirror", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "member",
          org,
          registrar,
          label: person.ensName.split(".")[0],
          wallet: person.owner,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { mirrored?: boolean; reason?: string; error?: string };
      const ok = res.ok && body.mirrored === true;
      setNotes((n) => ({
        ...n,
        [person.key]: { ok, text: ok ? "mirrored" : body.error ?? body.reason ?? `mirror failed (${res.status})` },
      }));
      if (ok) await reloadUsers();
    } catch (e) {
      setNotes((n) => ({ ...n, [person.key]: { ok: false, text: e instanceof Error ? e.message : "mirror failed" } }));
    } finally {
      setBusy(null);
    }
  }

  async function disable(person: Person) {
    if (!person.enforcerId) return;
    setBusy(person.key);
    try {
      await api.patch(`users/${person.enforcerId}`, { disabled: true });
      setNotes((n) => ({ ...n, [person.key]: { ok: true, text: "disabled" } }));
      await reloadUsers();
    } catch (e) {
      setNotes((n) => ({ ...n, [person.key]: { ok: false, text: e instanceof Error ? e.message : "failed" } }));
    } finally {
      setBusy(null);
    }
  }

  // Every read below belongs to one organization. The enforcer has no organization column — it
  // matches on the ENS name's suffix — so an unscoped read shows somebody else's people.
  if (!org) {
    return (
      <>
        <PageHeader eyebrow="Operate" title="People" />
        <div className="px-5 py-6 lg:px-8">
          <NoOrgSelected />
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="Operate"
        title="People"
        meta={
          chainAnswered && enforcerAnswered
            ? disagreeing.length === 0
              ? `${people.length} in ${org}.eth · chain and enforcer agree`
              : `${people.length} in ${org}.eth · ${disagreeing.length} disagree`
            : `${org}.eth`
        }
        actions={
          <Button variant="solid" onClick={() => setOnboarding((o) => !o)}>
            {onboarding ? "Cancel" : "Onboard someone"}
          </Button>
        }
      />

      <div className="space-y-6 px-5 py-6 lg:px-8">
        {onboarding ? (
          <div className="max-w-[560px]">
            <OnboardForm org={org} onDone={() => void reloadUsers()} />
          </div>
        ) : null}

        <SourceNotices
          chainError={chainError}
          enforcerError={enforcerError}
          sessionsError={sessionsError}
        />

        <Panel as="section" className="overflow-hidden">
          <PanelHeader
            right={
              <label className="flex items-center gap-2 font-mono text-[0.6875rem] text-ink-muted">
                <input
                  type="checkbox"
                  checked={onlyDisagreements}
                  onChange={(e) => setOnlyDisagreements(e.target.checked)}
                  className="size-3.5 accent-[var(--signal)]"
                />
                only disagreements
              </label>
            }
          >
            {org}.eth
          </PanelHeader>

          {chainStale && !chainError ? (
            <p className="border-b border-rule px-4 py-2.5 text-xs leading-relaxed text-ink-muted">
              The ENS index is{" "}
              <span className="font-mono text-ink">{chainLag ?? "?"}</span> blocks behind.{" "}
              {chainSource === "chain" ? (
                <>
                  The memberships below were therefore read back off the registry one by one,
                  from the names this console recorded writing — so the chain column is the
                  chain&apos;s own answer, not the index&apos;s. A membership written from
                  somewhere else may still be missing until the index catches up.
                </>
              ) : (
                <>
                  Nobody below is being called unregistered on the strength of that — the chain
                  column reads <span className="font-mono">not read</span> until the index catches
                  up. Perimeters and organizations are unaffected; those are read from the chain
                  directly.
                </>
              )}
            </p>
          ) : null}

          {!chainAnswered && !enforcerAnswered ? (
            <p role="status" className="px-4 py-16 text-center text-sm" style={{ color: chainError || enforcerError ? "var(--alert)" : undefined }}>
              {chainError || enforcerError ? (
                <span className="text-ink-muted">
                  Neither the chain nor the enforcer answered, so nobody is listed rather than
                  listing nobody.
                </span>
              ) : (
                <span className="font-mono text-xs text-ink-muted">Reading both sources…</span>
              )}
            </p>
          ) : chainLoading && people.length === 0 ? (
            <p className="px-4 py-10 text-center font-mono text-xs text-ink-muted">Reading…</p>
          ) : shown.length === 0 ? (
            <div role="status" className="px-4 py-16 text-center">
              <p className="text-sm text-ink">
                {onlyDisagreements ? "Nothing disagrees" : "Nobody here yet"}
              </p>
              <p className="mx-auto mt-1.5 max-w-[46ch] text-sm text-ink-muted">
                {onlyDisagreements
                  ? "Every membership the chain knows has a row on the enforcer, and the reverse."
                  : "Onboarding mints a name under a perimeter registrar and mirrors it to the enforcer in the same step."}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] border-collapse text-left">
                <caption className="sr-only">
                  People in {org}.eth, with what the chain and the perimeter enforcer each say
                </caption>
                <thead>
                  <tr className="border-b border-rule">
                    {COLUMNS.map((h, i) => (
                      <th key={h || i} scope="col" className="label px-4 py-2.5 font-normal">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-rule">
                  {shown.map((p) => {
                    const note = notes[p.key];
                    const registrar = p.branch ? registrarFor.get(p.branch) : null;
                    return (
                      <tr key={p.key} className="transition-colors hover:bg-ink/5">
                        <th scope="row" className="px-4 py-3 text-left font-normal">
                          {(() => {
                            const badgeLabel = p.ensName?.split(".")[0];
                            const sp = badgeLabel ? scraperProfiles[badgeLabel] : undefined;
                            const inner = (
                              <span className="flex items-center gap-2">
                                {sp?.image ? (
                                  // eslint-disable-next-line @next/next/no-img-element
                                  <img
                                    src={sp.image}
                                    alt=""
                                    className="size-8 shrink-0 rounded-full border border-rule object-cover"
                                  />
                                ) : null}
                                <span className="min-w-0">
                                  {sp?.name ? (
                                    <span className="block truncate text-xs font-medium text-ink">{sp.name}</span>
                                  ) : null}
                                  <span className="block max-w-[28ch] truncate font-mono text-xs text-ink-muted">
                                    {p.ensName ?? p.username}
                                  </span>
                                </span>
                              </span>
                            );
                            return p.enforcerId ? (
                              <button
                                type="button"
                                onClick={() => setSelected(p.enforcerId)}
                                className="text-left"
                              >
                                {inner}
                              </button>
                            ) : (
                              <span>{inner}</span>
                            );
                          })()}
                          {p.owner ? (
                            <span className="mt-0.5 block font-mono text-[0.625rem] text-ink-muted">
                              {p.owner.slice(0, 6)}…{p.owner.slice(-4)}
                            </span>
                          ) : null}
                        </th>

                        <td className="px-4 py-3 font-mono text-xs text-ink-80">
                          {p.chainRole ?? <Absent answered={chainAnswered} />}
                        </td>

                        <td className="px-4 py-3 font-mono text-xs text-ink-80">
                          {p.enforcerId ? (
                            <>
                              {p.enforcerGroup ?? "no group"}
                              {p.disabled ? <span className="text-ink-muted"> · disabled</span> : null}
                            </>
                          ) : (
                            <Absent answered={enforcerAnswered} />
                          )}
                        </td>

                        <td className="px-4 py-3">
                          {p.online === null ? (
                            <span className="font-mono text-xs text-ink-muted" title="The session read did not answer.">
                              unknown
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 font-mono text-xs">
                              <span
                                aria-hidden
                                className="size-1.5 rounded-full"
                                style={{ background: p.online ? "var(--signal)" : "var(--ink-faint)" }}
                              />
                              <span className={p.online ? "text-ink-80" : "text-ink-muted"}>
                                {p.online ? "online" : "offline"}
                              </span>
                            </span>
                          )}
                        </td>

                        <td className="px-4 py-3">
                          <StandingTag standing={p.standing} />
                        </td>

                        <td className="px-4 py-3">
                          <div className="flex flex-col items-start gap-1">
                            {p.standing === "chain-only" ? (
                              <Button
                                variant="outline"
                                className="h-9 px-3"
                                disabled={busy === p.key || !registrar || !p.owner}
                                title={
                                  registrar
                                    ? "Re-reads the chain, then writes the enforcer row."
                                    : "That perimeter publishes no registrar, so the chain cannot be re-read."
                                }
                                onClick={() => void retryMirror(p)}
                              >
                                {busy === p.key ? "Mirroring…" : "Retry mirror"}
                              </Button>
                            ) : p.standing === "enforcer-only" && !p.disabled ? (
                              <Button
                                variant="outline"
                                className="h-9 px-3"
                                disabled={busy === p.key}
                                title="Keeps their history; the door stops admitting them."
                                onClick={() => void disable(p)}
                              >
                                {busy === p.key ? "Disabling…" : "Disable"}
                              </Button>
                            ) : null}
                            {note ? (
                              <span
                                className="font-mono text-[0.625rem]"
                                style={{ color: note.ok ? "var(--ink-muted)" : "var(--alert)" }}
                                role="status"
                              >
                                {note.text}
                              </span>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <p className="border-t border-rule px-4 py-3 text-xs leading-relaxed text-ink-muted">
            The chain says who holds a membership; the enforcer&rsquo;s copy is what the proxy and
            the captive portal actually read when somebody asks to get on. A membership with no
            enforcer row is refused at the door despite being real, and an enforcer row with no
            membership admits somebody the chain no longer recognises.
          </p>
        </Panel>

        {/* Enforcer users — the raw enforcer-side view, including users with no ENS name */}
        <Panel as="section" className="overflow-hidden">
        <PanelHeader
          right={
            <span className="flex flex-wrap items-center gap-2">
              <select
                value={userGroupFilter}
                onChange={(e) => { setUserGroupFilter(e.target.value); setUserOffset(0); }}
                aria-label="Filter by group"
                className="h-9 rounded-sharp border border-rule bg-paper px-2 font-mono text-[0.6875rem] text-ink"
              >
                <option value="">every group</option>
                {(groups ?? []).map((g) => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
              <select
                value={userDisabledFilter}
                onChange={(e) => { setUserDisabledFilter(e.target.value); setUserOffset(0); }}
                aria-label="Filter by status"
                className="h-9 rounded-sharp border border-rule bg-paper px-2 font-mono text-[0.6875rem] text-ink"
              >
                <option value="">any status</option>
                <option value="0">active only</option>
                <option value="1">disabled only</option>
              </select>
              <Button variant="outline" onClick={() => setAddingUser((a) => !a)} disabled={!groups?.length}>
                {addingUser ? "Cancel" : "Add a user"}
              </Button>
            </span>
          }
        >
          Enforcer users
        </PanelHeader>

        {addingUser && groups?.length ? (
          <div className="border-b border-rule px-4 py-4">
            <CreateUser
              groups={groups}
              onDone={() => { setAddingUser(false); void reloadEnforcerUsers(); }}
            />
          </div>
        ) : null}

        {enforcerUsersError instanceof ApiError && enforcerUsersError.isUnauthenticated ? (
          <p className="px-4 py-8 text-xs leading-relaxed" style={{ color: "var(--alert)" }} role="status">
            This wallet has not proved it owns the organization.{" "}
            <a href="/console/signin" className="underline decoration-rule underline-offset-2">Sign a message to prove it</a>.
          </p>
        ) : enforcerUsersError ? (
          <p className="px-4 py-8 text-xs leading-relaxed" style={{ color: "var(--alert)" }} role="status">
            The enforcer did not answer. Nobody is listed rather than listing nobody.
          </p>
        ) : enforcerUsersLoading && !enforcerUsers ? (
          <p className="px-4 py-8 font-mono text-xs text-ink-muted">Reading…</p>
        ) : (enforcerUsers ?? []).length === 0 ? (
          <p className="px-4 py-8 text-sm text-ink-muted">
            {userGroupFilter || userDisabledFilter
              ? "Nobody matches those filters."
              : `Nobody from ${org}.eth yet. Members admitted appear here automatically.`}
          </p>
        ) : (
          <ul className="divide-y divide-rule">
            {(enforcerUsers ?? []).map((u) => (
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
                      {u.disabled ? <span className="shrink-0 font-mono text-[0.625rem] text-ink-muted">disabled</span> : null}
                    </span>
                    <span className="mt-0.5 block truncate font-mono text-[0.6875rem] text-ink-muted">
                      {u.ens_name ?? "no ENS name"}
                      {u.wallet_address ? ` · ${u.wallet_address.slice(0, 6)}…${u.wallet_address.slice(-4)}` : ""}
                    </span>
                  </span>
                  <span className="shrink-0 font-mono text-[0.6875rem] text-ink-muted">
                    {enforcerGroupName(groups, u)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {enforcerTotal !== undefined && enforcerTotal > 50 ? (
          <div className="flex items-center justify-between gap-3 border-t border-rule px-4 py-3">
            <span className="font-mono text-[0.625rem] text-ink-muted">
              {userOffset + 1}–{Math.min(userOffset + 50, enforcerTotal)} of {enforcerTotal}
            </span>
            <span className="flex gap-2">
              <Button variant="ghost" onClick={() => setUserOffset((o) => Math.max(0, o - 50))} disabled={userOffset === 0}>
                Previous
              </Button>
              <Button variant="ghost" onClick={() => setUserOffset((o) => o + 50)} disabled={userOffset + 50 >= enforcerTotal}>
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
          onChanged={() => { void reloadUsers(); void reloadEnforcerUsers(); }}
          onDeleted={() => {
            setSelected(null);
            void reloadUsers();
            void reloadEnforcerUsers();
          }}
        />
      ) : null}
    </>
  );
}

/**
 * Join the two sources on the full ENS name.
 *
 * The `answered` flags are the whole point: a side that did not answer contributes no rows and,
 * more importantly, licenses no conclusion about the rows the other side did contribute.
 */
function reconcile(input: {
  memberships: { name: string; branch: string; owner: string; role: string }[];
  users: { id: string; username: string; ens_name: string | null; default_group_id: string | null; disabled: number }[];
  sessions: { user_id: string }[];
  groups: { id: string; name: string }[];
  chainAnswered: boolean;
  enforcerAnswered: boolean;
  sessionsAnswered: boolean;
}): Person[] {
  const groupName = new Map(input.groups.map((g) => [g.id, g.name]));
  const onlineUserIds = new Set(input.sessions.map((s) => s.user_id));
  const byKey = new Map<string, Person>();

  for (const m of input.memberships) {
    const key = m.name.toLowerCase();
    byKey.set(key, {
      key,
      ensName: m.name,
      username: null,
      branch: m.branch,
      owner: m.owner,
      chainRole: m.role,
      enforcerId: null,
      enforcerGroup: null,
      disabled: false,
      online: null,
      standing: "unknown",
    });
  }

  for (const u of input.users) {
    // A row with no ENS name can never join to a membership; it still belongs on the list, under
    // a key of its own, rather than being silently dropped or matched to somebody.
    const key = u.ens_name ? u.ens_name.toLowerCase() : `enforcer:${u.id}`;
    const existing = byKey.get(key);
    const merged: Person = {
      ...(existing ?? {
        key,
        ensName: u.ens_name,
        username: u.username,
        branch: null,
        owner: null,
        chainRole: null,
        online: null,
        standing: "unknown",
      }),
      username: u.username,
      enforcerId: u.id,
      enforcerGroup: u.default_group_id ? groupName.get(u.default_group_id) ?? null : null,
      disabled: Boolean(u.disabled),
    };
    merged.online = input.sessionsAnswered ? onlineUserIds.has(u.id) : null;
    byKey.set(key, merged);
  }

  for (const person of byKey.values()) {
    const onChain = person.chainRole !== null;
    const inEnforcer = person.enforcerId !== null;
    person.standing =
      onChain && inEnforcer
        ? "both"
        : onChain
          ? // Only the enforcer having answered makes its silence about this person meaningful.
            input.enforcerAnswered
            ? "chain-only"
            : "unknown"
          : input.chainAnswered
            ? "enforcer-only"
            : "unknown";
    // Nobody the enforcer has no row for can be online, whatever the session read said.
    if (!inEnforcer) person.online = input.sessionsAnswered ? false : null;
  }

  return [...byKey.values()].sort((a, b) => {
    const rank = (p: Person) => (p.standing === "both" ? 1 : p.standing === "unknown" ? 2 : 0);
    return rank(a) - rank(b) || (a.ensName ?? a.username ?? "").localeCompare(b.ensName ?? b.username ?? "");
  });
}

const STANDING: Record<Standing, { label: string; hint: string; colour: string }> = {
  both: {
    label: "in both",
    hint: "The chain and the enforcer agree about this person.",
    colour: "var(--ink-muted)",
  },
  "chain-only": {
    label: "not mirrored",
    hint: "A real membership with no enforcer row — they will be refused at the door.",
    colour: "var(--alert)",
  },
  "enforcer-only": {
    label: "not on chain",
    hint: "An enforcer row with no membership behind it — revoked, or left over.",
    colour: "var(--alert)",
  },
  unknown: {
    label: "one source only",
    hint: "The other source did not answer, so nothing is claimed about this person.",
    colour: "var(--ink-muted)",
  },
};

function StandingTag({ standing }: { standing: Standing }) {
  const s = STANDING[standing];
  return (
    <span
      className="inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[0.6875rem] uppercase tracking-[0.1em]"
      style={{ color: s.colour, borderColor: standing === "both" || standing === "unknown" ? "var(--rule)" : s.colour }}
      title={s.hint}
    >
      {s.label}
    </span>
  );
}

/** An empty cell means two very different things, and it has to say which. */
function Absent({ answered }: { answered: boolean }) {
  return answered ? (
    <span className="text-ink-muted">—</span>
  ) : (
    <span className="text-ink-muted" title="That source did not answer.">
      not read
    </span>
  );
}

function SourceNotices({
  chainError,
  enforcerError,
  sessionsError,
}: {
  chainError: unknown;
  enforcerError: unknown;
  sessionsError: unknown;
}) {
  if (!chainError && !enforcerError && !sessionsError) return null;
  return (
    <div role="status" className="space-y-2">
      {chainError ? (
        <Notice>
          The perimeter registry did not answer, so the on-chain half of this list is missing. Rows
          below come from the enforcer alone and no one is marked as unmirrored.
        </Notice>
      ) : null}
      {enforcerError ? (
        <Notice>
          {enforcerError instanceof ApiError && enforcerError.isUnauthenticated ? (
            <>
              This wallet has not proved it owns the organization, so the enforcer&rsquo;s half of
              this list cannot be read.{" "}
              <a href="/console/signin" className="underline decoration-rule underline-offset-2">
                Sign a message to prove it
              </a>
              .
            </>
          ) : (
            <>
              The perimeter enforcer did not answer, so its half of this list is missing. Rows below
              come from the chain alone — nobody here is known to be missing a mirror.
            </>
          )}
        </Notice>
      ) : null}
      {sessionsError ? (
        <Notice>
          Sessions could not be read, so who is online is shown as unknown rather than as offline.
        </Notice>
      ) : null}
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="rounded-sharp border px-4 py-3 text-xs leading-relaxed"
      style={{ borderColor: "var(--alert)", color: "var(--alert)" }}
    >
      {children}
    </p>
  );
}

function enforcerGroupName(groups: Group[] | undefined, user: User): string {
  if (!user.default_group_id) return "no group";
  return groups?.find((g) => g.id === user.default_group_id)?.name ?? "—";
}

function CreateUser({ groups, onDone }: { groups: Group[]; onDone: () => void }) {
  const [username, setUsername] = useState("");
  const [ensName, setEnsName] = useState("");
  const [wallet, setWallet] = useState("");
  const [groupId, setGroupId] = useState(groups[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const valid = username.trim().length > 0 && !!groupId;

  async function submit() {
    setBusy(true);
    setMessage(null);
    try {
      await api.post("users", {
        username: username.trim(),
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
    <div className="space-y-4">
      <p className="max-w-[54ch] text-xs leading-relaxed text-ink-muted">
        Only needed for somebody who is not joining through ENS. A member who signs in with a name is created automatically.
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
            <option key={g.id} value={g.id}>{g.name} · {g.network_tier}</option>
          ))}
        </select>
      </label>
      {message ? (
        <p className="text-xs leading-relaxed" style={{ color: "var(--alert)" }} role="status">{message}</p>
      ) : null}
      <Button variant="solid" onClick={submit} disabled={!valid || busy}>
        {busy ? "Adding…" : "Add user"}
      </Button>
    </div>
  );
}

function generatedPassword(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
