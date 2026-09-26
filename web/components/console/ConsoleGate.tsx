"use client";

import { Suspense, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useAccount } from "wagmi";
import { useSWRConfig } from "swr";
import { SignalDither } from "@/components/dither/SignalDither";
import { SiteHeader } from "@/components/SiteHeader";
import { Button, ButtonLink } from "@/components/ui/Button";
import { OpenByNameField } from "@/components/console/OrgPicker";
import { useConsoleSession } from "@/lib/hooks/useConsoleSession";
import { useEnsBranches } from "@/lib/hooks/useEns";
import { useOrg, useOwnedOrgs } from "@/lib/hooks/useOrg";
import { usePerimeter } from "@/lib/hooks/usePerimeter";
import { short } from "@/components/WalletButton";

/**
 * The console's entrance.
 *
 * Three questions have to be answered before the console means anything: whose wallet is this,
 * which organization and perimeter are we looking at, and can this wallet prove the name is
 * actually theirs. Until all three are answered, none of the shell is drawn — not the nav, not
 * the perimeter list, not the enforcer status. A connect screen beside a full navigation rail
 * advertises a product the visitor cannot use and, worse, implies figures they are not seeing.
 *
 * The proof is scoped, never blanket. A session issued for `acme.eth` says nothing about
 * `other.eth`, and a session issued to one wallet says nothing after the visitor switches
 * accounts — so both are checked against what is on screen right now rather than trusted because
 * a cookie exists.
 */
export function ConsoleGate({ children }: { children: ReactNode }) {
  // `useOrg` and `usePerimeter` read the URL, which suspends during the static shell.
  return (
    <Suspense fallback={<Settling />}>
      <Gate>{children}</Gate>
    </Suspense>
  );
}

const STEPS = [
  { id: "wallet", title: "Wallet", blurb: "Connect the wallet that owns the organization." },
  {
    id: "organization",
    title: "Organization",
    blurb: "Choose the organization, then the perimeter inside it.",
  },
  { id: "ownership", title: "Ownership", blurb: "Sign to prove the name is yours." },
] as const;

/**
 * Has the browser taken over yet?
 *
 * `useSyncExternalStore` is the one way to ask that without writing state from an effect: it is
 * handed a different answer for the server render and the client, and React reconciles the two
 * itself instead of throwing the markup away.
 */
const subscribeToNothing = () => () => {};
const onClient = () => true;
const onServer = () => false;

/**
 * The perimeters page is where a perimeter gets made, so it cannot be the one thing you need a
 * perimeter to reach. Every other gate still applies to it.
 */
const PERIMETER_OPTIONAL = new Set(["/console/branches"]);

function Gate({ children }: { children: ReactNode }) {
  const { address, status } = useAccount();
  const pathname = usePathname();
  const org = useOrg();
  const perimeter = usePerimeter();
  const { session, isLoading: sessionLoading, error: sessionError } = useConsoleSession();

  // Which gate applies is decided entirely in the browser — the wallet lives there and the
  // server has no way to know about it. Rendering the answer before the first effect would mean
  // rendering a guess, and React would then throw away the server's markup for disagreeing with
  // it. So the first paint on both sides says the same thing: we are still reading.
  const mounted = useSyncExternalStore(subscribeToNothing, onClient, onServer);

  // Not asked yet, still asking, and answered are three different things. wagmi reports
  // "reconnecting" on every reload while it restores the previous connection; painting the
  // connect screen then would throw a visitor who is already connected back to step one for a
  // beat, and they would reach for the button.
  if (!mounted || status === "connecting" || status === "reconnecting") return <Settling />;

  if (status !== "connected" || !address) {
    return (
      <Frame index={0}>
        <ConnectGate />
      </Frame>
    );
  }

  if (!org) {
    return (
      <Frame index={1}>
        <ChooseOrganization />
      </Frame>
    );
  }

  if (!perimeter && !PERIMETER_OPTIONAL.has(pathname)) {
    return (
      <Frame index={1}>
        <ChoosePerimeter org={org} />
      </Frame>
    );
  }

  // The session cookie is read once per page load. Until that read lands we do not know whether
  // ownership was proved, and guessing "no" flashes the signature screen at somebody who has
  // already signed.
  if (sessionLoading && !session && !sessionError) return <Settling />;

  const proved =
    session !== null &&
    session.org === org &&
    session.address.toLowerCase() === address.toLowerCase();

  if (!proved) {
    return (
      <Frame index={2}>
        <ProveOwnership org={org} address={address} />
      </Frame>
    );
  }

  return <>{children}</>;
}

/**
 * The gate's composition, shared with the create flow.
 *
 * One question on one screen over the same dithered weather, with the step count above it and a
 * measure below — so arriving at the console and creating an organization read as one product
 * rather than two that happen to share a palette.
 */
function Frame({ index, children }: { index: number | null; children: ReactNode }) {
  return (
    <>
      <SiteHeader />
      <main
        id="main"
        className="relative flex flex-1 items-center justify-center overflow-hidden px-5 py-14 lg:min-h-[calc(100svh-3.5rem)] lg:py-16"
      >
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <SignalDither
            motif="liquid"
            cell={4}
            period={30}
            intensity={0.34}
            className="absolute inset-0"
          />
        </div>

        <div className="relative w-full max-w-[46rem]">
          <div className="flex items-baseline justify-between gap-4 border-b border-rule pb-3">
            <span className="label">
              {index === null
                ? `— / ${String(STEPS.length).padStart(2, "0")}`
                : `${String(index + 1).padStart(2, "0")} / ${String(STEPS.length).padStart(2, "0")}`}
            </span>
            <span className="label">Open the console</span>
          </div>

          <div className="mt-10 min-w-0">{children}</div>

          {index === null ? null : <Rail current={index} />}
        </div>
      </main>
    </>
  );
}

function Rail({ current }: { current: number }) {
  return (
    <div className="mt-12 border-t border-rule pt-4">
      <ol className="flex items-center gap-1.5">
        {STEPS.map((s, i) => (
          <li key={s.id} className="h-px flex-1" aria-current={i === current ? "step" : undefined}>
            <span
              aria-hidden
              className="block h-px w-full"
              style={{
                background:
                  i < current ? "var(--ink-muted)" : i === current ? "var(--ink)" : "var(--rule)",
                height: i === current ? 2 : 1,
              }}
            />
          </li>
        ))}
      </ol>
      <p className="mt-3 flex items-baseline justify-between gap-4">
        <span className="font-mono text-xs text-ink">{STEPS[current]!.title}</span>
        <span className="hidden text-xs leading-relaxed text-ink-muted sm:block">
          {STEPS[current]!.blurb}
        </span>
      </p>
    </div>
  );
}


/** Points at the header's control, in the same weight as the rules above and below it. */
function UpRight() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
      className="shrink-0"
    >
      <path d="M4.5 11.5 11.5 4.5M5.75 4.5h5.75V10.25" />
    </svg>
  );
}

function Settling() {
  return (
    // The same frame as every other gate, minus the step marks. Rendering a bare line of text on
    // an empty page made the first paint look like a failure — and if the wallet check never
    // resolves, that is the whole console: no header, no ground, no way to tell a slow read from
    // a broken app.
    <Frame index={null}>
      <p className="font-mono text-xs text-ink-muted" role="status">
        reading…
      </p>
      <p className="mt-3 max-w-[52ch] text-sm leading-relaxed text-ink-muted">
        Checking whether a wallet is connected and whether it has already proved ownership.
      </p>
    </Frame>
  );
}

/**
 * Gate one has no button.
 *
 * It used to carry a `Connect wallet` pill in the middle of the page while the site header
 * carried an identical one in the corner — the same control twice on a screen with one thing to
 * do, which reads as two different things to do. The header's is the one that persists through
 * every later step, so it is the one that stays, and this screen points at it instead of
 * competing with it.
 */
function ConnectGate() {
  return (
    <section>
      <h1 className="text-2xl tracking-[-0.02em] text-ink sm:text-[1.75rem]">Connect a wallet</h1>
      <p className="mt-3 max-w-[54ch] text-sm leading-relaxed text-ink-muted">
        The console answers for one organization at a time, and which one it may answer for
        depends on the wallet holding the name. Until there is a wallet there is no organization
        to show, so there is nothing here yet.
      </p>

      {/* One wallet control on the screen, and it is the header's — the one that persists
          through every later step and through the console itself. A second, identical pill in
          the body made one thing to do look like two. */}
      <p className="mt-8 flex items-center gap-2.5 border-y border-rule py-3.5 font-mono text-xs uppercase tracking-[0.12em] text-ink">
        <UpRight />
        Connect wallet, top right
      </p>

      <p className="mt-6 max-w-[54ch] text-xs leading-relaxed text-ink-muted">
        Connecting reads only — nothing is signed and nothing is spent. No organization yet?{" "}
        <Link href="/create" className="underline decoration-rule underline-offset-2 hover:text-ink">
          Create one
        </Link>
        .
      </p>
    </section>
  );
}

/** Points at the header's wallet control, which is where the only action on this screen lives. */
function ChooseOrganization() {
  const { organizations, error, isLoading } = useOwnedOrgs();

  const ready = (organizations ?? []).filter((o) => o.ready === true);
  const notYet = (organizations ?? []).filter((o) => o.ready !== true);

  return (
    <section>
      <h1 className="text-2xl tracking-[-0.02em] text-ink sm:text-[1.75rem]">
        Choose an organization
      </h1>
      <p className="mt-2 max-w-[56ch] text-sm leading-relaxed text-ink-muted">
        Each one is a <span className="font-mono">.eth</span> name this wallet holds, with its own
        registry, resolver and perimeter factory underneath it.
      </p>

      <div className="mt-6">
        {/* Three answers, not two: the read failed, the read has not come back, or the wallet
            genuinely holds nothing set up. Collapsing the first into the third tells somebody
            their organizations are gone when the indexer merely did not reply. */}
        {error ? (
          <p className="max-w-[56ch] text-sm leading-relaxed" style={{ color: "var(--alert)" }}>
            Could not read the names this wallet holds. That is a failed read, not an empty
            account — open one by name below instead, which asks the registry directly.
          </p>
        ) : isLoading && !organizations ? (
          <p className="font-mono text-xs text-ink-muted">reading…</p>
        ) : ready.length === 0 ? (
          <p className="max-w-[56ch] text-sm leading-relaxed text-ink-muted">
            None of this wallet&rsquo;s names is set up as an organization yet.
          </p>
        ) : (
          <ul className="max-h-[19rem] divide-y divide-rule overflow-y-auto border-y border-rule">
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

      <div className="mt-8">
        <span className="label">Open one by name</span>
        <p className="mt-1 max-w-[56ch] text-xs leading-relaxed text-ink-muted">
          Read straight from the registry, so an organization set up in the last few minutes is
          reachable before the indexer has caught up with it.
        </p>
        <div className="mt-3">
          <OpenByNameField />
        </div>
      </div>

      {notYet.length > 0 ? (
        <p className="mt-8 max-w-[56ch] text-xs leading-relaxed text-ink-muted">
          {notYet.length === 1 ? "One other name" : `${notYet.length} other names`} on this wallet
          {notYet.length === 1 ? " has" : " have"} no contracts underneath{" "}
          {notYet.length === 1 ? "it" : "them"}.{" "}
          <Link
            href="/create"
            className="underline decoration-rule underline-offset-2 hover:text-ink"
          >
            Set one up
          </Link>
          .
        </p>
      ) : null}
    </section>
  );
}

////////////////////////////////////////////////////////////////////////
// Gate 2b — the perimeter
////////////////////////////////////////////////////////////////////////

function ChoosePerimeter({ org }: { org: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { mutate } = useSWRConfig();
  const { branches, isLoading, error } = useEnsBranches(org);

  function hrefFor(label: string) {
    const next = new URLSearchParams(params.toString());
    next.set("perimeter", label);
    return `${pathname}?${next.toString()}`;
  }

  // One perimeter is not a choice, and presenting it as one makes every visit to a
  // single-site organization cost a click that has no alternative.
  const only = branches?.length === 1 ? branches[0]!.label : null;
  useEffect(() => {
    if (only) router.replace(hrefFor(only));
    // `hrefFor` closes over the current URL, which is exactly what should re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [only, pathname, params.toString()]);

  return (
    <section>
      <h1 className="text-2xl tracking-[-0.02em] text-ink sm:text-[1.75rem]">
        Choose a perimeter
      </h1>
      <p className="mt-2 max-w-[56ch] text-sm leading-relaxed text-ink-muted">
        A perimeter is one place <span className="font-mono">{org}.eth</span> enforces — a site,
        a floor, a venue. It has its own registry, its own groups and its own enforcer, so the
        console has to know which one it is answering for.
      </p>

      <div className="mt-6">
        {/* The registry read has three outcomes and they are not interchangeable: it failed, it
            has not answered yet, or it answered that there are none. */}
        {error ? (
          <div className="space-y-3">
            <p className="max-w-[56ch] text-sm leading-relaxed" style={{ color: "var(--alert)" }}>
              Could not read the perimeters under {org}.eth. Nothing is listed because the read
              failed, which is not the same as this organization having none.
            </p>
            <Button variant="outline" onClick={() => void mutate(`ens-branches:${org}`)}>
              Try again
            </Button>
          </div>
        ) : isLoading && branches === undefined ? (
          <p className="font-mono text-xs text-ink-muted">reading…</p>
        ) : branches === undefined ? (
          <p className="font-mono text-xs text-ink-muted">not read yet</p>
        ) : branches.length === 0 ? (
          <div className="space-y-4">
            <p className="max-w-[56ch] text-sm leading-relaxed text-ink-muted">
              {org}.eth has no perimeters yet. Opening one registers a name beneath the
              organization and deploys the registry that admits people to it.
            </p>
            <ButtonLink href={`/console/branches?org=${org}`} variant="solid">
              Open the first perimeter
            </ButtonLink>
          </div>
        ) : only ? (
          <p className="font-mono text-xs text-ink-muted" role="status">
            opening {only}…
          </p>
        ) : (
          <ul className="max-h-[19rem] divide-y divide-rule overflow-y-auto border-y border-rule">
            {branches.map((b) => (
              <li key={b.name} className="flex items-center justify-between gap-4 py-3">
                <span className="min-w-0">
                  <span className="block truncate font-mono text-sm text-ink">{b.name}</span>
                  <span className="block font-mono text-[0.6875rem] text-ink-muted">
                    {/* `null` is the indexer not having reached this perimeter, which is a
                        different thing from it having no members. */}
                    {b.memberCount === null
                      ? "member count not indexed yet"
                      : `${b.memberCount} ${b.memberCount === 1 ? "member" : "members"}`}
                  </span>
                </span>
                <ButtonLink href={hrefFor(b.label)} variant="solid">
                  Open
                </ButtonLink>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="mt-8 text-xs text-ink-muted">
        <Link href="/console" className="underline decoration-rule underline-offset-2 hover:text-ink">
          Choose a different organization
        </Link>
      </p>
    </section>
  );
}

////////////////////////////////////////////////////////////////////////
// Gate 3 — ownership
////////////////////////////////////////////////////////////////////////

/**
 * Prove you own the organization.
 *
 * There is no console token. Operating the enforcer is allowed to exactly the wallet that holds
 * the organization's `.eth` name, which is the same authority the contracts already enforce for
 * every write — so there is one answer to "who is in charge here", not two, and nothing has to
 * be provisioned out of band before somebody can run their own organization.
 */
export function ProveOwnership({ org, address }: { org: string; address: string }) {
  const { session, signIn, signOut } = useConsoleSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A session for another name or another account is not a failure and not an absence — say
  // which it is, because "sign again" without a reason looks like the last signature was lost.
  const mismatch =
    session === null
      ? null
      : session.org !== org
        ? `This browser is proved for ${session.org}.eth, not ${org}.eth.`
        : session.address.toLowerCase() !== address.toLowerCase()
          ? "This browser is proved for a different wallet than the one connected."
          : null;

  async function prove() {
    setBusy(true);
    setError(null);
    try {
      await signIn(org);
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not sign in");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h1 className="text-2xl tracking-[-0.02em] text-ink sm:text-[1.75rem]">
        Prove you own {org}.eth
      </h1>
      <p className="mt-2 max-w-[56ch] text-sm leading-relaxed text-ink-muted">
        Reading an organization needs nothing — it is all public. Changing what its perimeter
        enforcer does needs a signature from the wallet that holds the name, because that wallet
        is who the chain says runs it.
      </p>

      <div className="mt-6 flex items-center justify-between gap-3 rounded-sharp border border-rule bg-paper px-3 py-2.5">
        <span className="flex min-w-0 items-center gap-2.5">
          <span
            aria-hidden
            className="size-1.5 shrink-0 rounded-full"
            style={{ background: "var(--signal)" }}
          />
          <span className="truncate font-mono text-sm text-ink">{short(address)}</span>
        </span>
        <span className="shrink-0 font-mono text-[0.6875rem] text-ink-muted">will sign</span>
      </div>

      {mismatch ? (
        <p className="mt-4 max-w-[56ch] text-xs leading-relaxed text-ink-muted">
          {mismatch} A proof is issued for one name and one wallet, so it does not carry over.
        </p>
      ) : null}

      <div className="mt-6 flex flex-wrap items-center gap-2">
        <Button variant="solid" onClick={prove} disabled={busy}>
          {busy ? "Waiting for the signature…" : "Sign to prove ownership"}
        </Button>
        {session ? (
          <Button variant="ghost" onClick={() => void signOut()}>
            Sign out
          </Button>
        ) : null}
      </div>

      {error ? (
        <p
          className="mt-4 max-w-[56ch] text-xs leading-relaxed"
          style={{ color: "var(--alert)" }}
          role="status"
        >
          {error}
        </p>
      ) : null}

      <p className="mt-6 max-w-[56ch] text-xs leading-relaxed text-ink-muted">
        A plain message, not a transaction. It costs nothing and moves nothing.{" "}
        <Link href="/console" className="underline decoration-rule underline-offset-2 hover:text-ink">
          Choose a different organization
        </Link>
        .
      </p>
    </section>
  );
}
