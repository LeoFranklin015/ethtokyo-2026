"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAccount } from "wagmi";
import { Button } from "@/components/ui/Button";
import { ButtonLink } from "@/components/ui/Button";
import { Panel } from "@/components/ui/Panel";
import { WalletButton } from "@/components/WalletButton";
import { useOwnedOrgs } from "@/lib/hooks/useOrg";

/**
 * Which organization are you working in?
 *
 * The console's first question, and it did not used to ask it: the organization was a constant,
 * so whatever you had just created, this showed somebody else's branches, groups and members.
 *
 * The list is the top-level `.eth` names this wallet holds, because that is what an organization
 * is — a name somebody owns, with contracts under it. Names that have not been set up are shown
 * too rather than hidden, since "I own it but it is not an organization yet" is the state most
 * people are in on their first visit, and hiding it makes the console look empty for no reason.
 *
 * The list comes from the ENS indexer, which can be behind or stopped — so an organization set
 * up minutes ago may not be in it. That is why the box at the bottom exists: it resolves a name
 * straight from the chain, so a fresh organization is always reachable even when nothing has
 * indexed it yet. Without it, the only way in was to wait.
 */
export function OrgPicker() {
  const { isConnected } = useAccount();
  const { organizations, error, isLoading } = useOwnedOrgs();

  if (!isConnected) {
    return (
      <Panel as="section" className="max-w-[560px]">
        <div className="px-5 py-6">
          <h2 className="text-lg tracking-[-0.01em] text-ink">Connect a wallet</h2>
          <p className="mt-2 max-w-[52ch] text-sm leading-relaxed text-ink-muted">
            The console shows the organizations your wallet owns. Nothing here is signed for you —
            every write goes out from your own account, and the contracts decide what it may do.
          </p>
          <div className="mt-5">
            <WalletButton />
          </div>
        </div>
      </Panel>
    );
  }

  const ready = (organizations ?? []).filter((o) => o.ready === true);
  const notYet = (organizations ?? []).filter((o) => o.ready !== true);

  return (
    <div className="max-w-[640px] space-y-6">
      <Panel as="section">
        <div className="px-5 py-6">
          <h2 className="text-lg tracking-[-0.01em] text-ink">Your organizations</h2>
          <p className="mt-2 max-w-[52ch] text-sm leading-relaxed text-ink-muted">
            Each one is a <span className="font-mono">.eth</span> name you hold, with its own
            registry, resolver and branch factory underneath it.
          </p>

          {error ? (
            <p className="mt-4 text-xs leading-relaxed" style={{ color: "var(--alert)" }}>
              Could not read your names. This is a read failure, not an empty account — nothing
              is listed rather than listing nothing.
            </p>
          ) : isLoading && !organizations ? (
            <p className="mt-4 font-mono text-xs text-ink-muted">reading…</p>
          ) : ready.length === 0 ? (
            <p className="mt-4 max-w-[52ch] text-sm leading-relaxed text-ink-muted">
              None of your names is set up yet.
            </p>
          ) : (
            <ul className="mt-5 max-h-[19rem] divide-y divide-rule overflow-y-auto border-y border-rule">
              {ready.map((o) => (
                <li key={o.name} className="flex items-center justify-between gap-4 py-3">
                  <span className="min-w-0">
                    <span className="block truncate font-mono text-sm text-ink">{o.name}</span>
                    {o.expiry ? (
                      <span className="block font-mono text-[0.6875rem] text-ink-muted">
                        expires {new Date(o.expiry * 1000).toLocaleDateString()}
                      </span>
                    ) : null}
                  </span>
                  <ButtonLink href={`/console?org=${o.label}`} variant="solid">
                    Open
                  </ButtonLink>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Panel>

      {notYet.length > 0 ? (
        <Panel as="section">
          <div className="px-5 py-6">
            <h2 className="text-sm tracking-[-0.01em] text-ink">Names not set up yet</h2>
            <p className="mt-1 max-w-[52ch] text-xs leading-relaxed text-ink-muted">
              You own these, but they have no contracts under them. Setting one up deploys its
              registry, resolver and registrars — all owned by you.
            </p>
            <ul className="mt-4 max-h-[14rem] divide-y divide-rule overflow-y-auto border-y border-rule">
              {notYet.map((o) => (
                <li key={o.name} className="flex items-center justify-between gap-4 py-2.5">
                  <span className="min-w-0">
                    <span className="block truncate font-mono text-sm text-ink">{o.name}</span>
                    {o.ready === null ? (
                      <span className="block font-mono text-[0.6875rem] text-ink-muted">
                        could not check
                      </span>
                    ) : null}
                  </span>
                  <ButtonLink href="/create">Set it up</ButtonLink>
                </li>
              ))}
            </ul>
          </div>
        </Panel>
      ) : null}

      <OpenByName />

      <p className="text-sm text-ink-muted">
        No name yet?{" "}
        <Link href="/create" className="underline decoration-rule underline-offset-2 hover:text-ink">
          Create an organization
        </Link>
        .
      </p>
    </div>
  );
}

/**
 * Open an organization by name, read from the chain.
 *
 * The list above is only as complete as the indexer, and a name registered since its last
 * indexed block is missing from it entirely — along with any organization built on that name.
 * This asks the registry directly, so "I made it a minute ago and cannot see it" has an answer.
 */
function OpenByName() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const label = value.trim().toLowerCase().replace(/\.eth$/, "");

  async function open() {
    setChecking(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/ens/org?name=${encodeURIComponent(label)}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error("could not read that name");
      const body = (await res.json()) as { organization: unknown | null };
      if (!body.organization) {
        setMessage(`${label}.eth is not set up as an organization yet.`);
        return;
      }
      router.push(`/console?org=${label}`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "could not read that name");
    } finally {
      setChecking(false);
    }
  }

  return (
    <Panel as="section">
      <div className="px-5 py-5">
        <h2 className="text-sm tracking-[-0.01em] text-ink">Open one by name</h2>
        <p className="mt-1 max-w-[52ch] text-xs leading-relaxed text-ink-muted">
          Read straight from the registry, so an organization set up in the last few minutes is
          reachable before the indexer has caught up with it.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="flex h-11 min-w-0 flex-1 items-center rounded-sharp border border-rule bg-paper px-3">
            <input
              value={value}
              onChange={(e) => {
                setValue(e.target.value.replace(/[^a-zA-Z0-9-]/g, "").toLowerCase());
                setMessage(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && label) void open();
              }}
              placeholder="acme"
              aria-label="Organization name"
              autoComplete="off"
              className="min-w-0 flex-1 bg-transparent font-mono text-sm text-ink outline-none placeholder:text-ink-faint"
            />
            <span className="shrink-0 font-mono text-sm text-ink-muted">.eth</span>
          </span>
          <Button variant="outline" onClick={open} disabled={!label || checking}>
            {checking ? "Reading…" : "Open"}
          </Button>
        </div>
        {message ? (
          <p className="mt-2 text-xs leading-relaxed" style={{ color: "var(--alert)" }} role="status">
            {message}
          </p>
        ) : null}
      </div>
    </Panel>
  );
}

/** Shown on org-scoped pages when the console has no organization selected. */
export function NoOrgSelected() {
  return (
    <Panel as="section" className="max-w-[520px]">
      <div className="px-5 py-6">
        <h2 className="text-lg tracking-[-0.01em] text-ink">No organization selected</h2>
        <p className="mt-2 max-w-[50ch] text-sm leading-relaxed text-ink-muted">
          This page reads one organization&rsquo;s branches, groups and members. Pick which.
        </p>
        <div className="mt-5">
          <ButtonLink href="/console" variant="solid">
            Choose an organization
          </ButtonLink>
        </div>
      </div>
    </Panel>
  );
}
