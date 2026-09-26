"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useAccount, useConnect, useDisconnect, useSignMessage } from "wagmi";
import { SignalDither } from "@/components/dither/SignalDither";
import { QrScanner } from "@/components/QrScanner";
import { short } from "@/components/WalletButton";
import { Button } from "@/components/ui/Button";

/**
 * Getting a guest onto the network.
 *
 * Three things in order: the badge says who they claim to be, the wallet must be the one that
 * badge was registered to, and a signature proves they hold it. Only then does `verify` ask the
 * branch enforcer to open the firewall.
 *
 * The badge comes first on purpose. Searching every branch for a wallet is a chain scan on an
 * unauthenticated path; a five-character label is one lookup, and it also means a guest holding
 * the wrong wallet can be told *which* wallet the badge expects instead of being refused with
 * nothing to act on.
 *
 * Every way this fails is its own message. A guest standing in a lobby cannot tell a blocked
 * camera from an unknown badge from a dead enforcer unless the page tells them, and the
 * difference decides whether they tap retry, find an organizer, or switch wallets.
 */

type Badge = {
  id: string;
  name: string;
  /** The member's own name from the resolver, absent for anyone onboarded before it was written. */
  displayName: string | null;
  wallet: string;
  branch: string;
  role: string;
};

type Trouble = { title: string; body: string };

type Step = "badge" | "wallet" | "sign" | "online";

const STEPS: { key: Step; label: string }[] = [
  { key: "badge", label: "Badge" },
  { key: "wallet", label: "Wallet" },
  { key: "sign", label: "Sign" },
  { key: "online", label: "Online" },
];

export function PortalFlow() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending: connecting, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();
  const { signMessageAsync } = useSignMessage();
  const reduceMotion = useReducedMotion();

  const [step, setStep] = useState<Step>("badge");
  const [badge, setBadge] = useState<Badge | null>(null);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState<"" | "badge" | "sign">("");
  const [trouble, setTrouble] = useState<Trouble | null>(null);
  const [grant, setGrant] = useState<[string, string][]>([]);
  // An admission that happened before this page was opened reads differently from one this
  // flow just performed, and a captive portal is reopened constantly.
  const [alreadyOnline, setAlreadyOnline] = useState(false);
  // A wallet prompt cannot be withdrawn from this side, so leaving the signing screen only
  // abandons the attempt. Bumping this marks everything already in flight as stale, otherwise a
  // signature approved a minute after the guest gave up would drag them back onto a finished
  // screen — or announce them online under a badge they had already replaced.
  const attempt = useRef(0);
  // Read through the store hook rather than at render: the server has no window, and a
  // hydration mismatch here would flash a dead connect button at the one person who cannot use
  // it. `null` on the server means "not known yet", which renders as the ordinary path.
  const injectedWallet = useSyncExternalStore(subscribeNothing, hasInjectedWallet, () => null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/portal/status", { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as {
          admitted: boolean | null;
          ens_name: string | null;
          tier: string | null;
        };
        // `null` is the enforcer not answering, which is not the same as "not admitted" — the
        // flow simply starts from the beginning rather than claiming either way.
        if (cancelled || body.admitted !== true) return;
        setAlreadyOnline(true);
        setGrant([
          ["Membership", body.ens_name ?? "—"],
          ["Tier", body.tier ?? "—"],
        ]);
        setStep("online");
      } catch {
        // Unreachable enforcer, captive DNS still hijacked, page opened off-network: none of
        // these are worth an error, because the flow below works from a clean start regardless.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // An injected connector is registered whether or not this webview has a wallet behind it, and
  // offering "Connect Injected" in a captive window that has none is the dead button this page
  // must not render. WalletConnect works without one, so it stays.
  const usable = connectors.filter((c) => c.type !== "injected" || injectedWallet !== false);

  const walletMatches =
    Boolean(badge) && isConnected && address?.toLowerCase() === badge?.wallet;

  async function lookUpBadge(id: string) {
    setScanning(false);
    setBusy("badge");
    setTrouble(null);
    try {
      const res = await fetch(`/api/portal/badge?id=${encodeURIComponent(id)}`, {
        cache: "no-store",
      });
      const body = (await res.json().catch(() => ({}))) as Partial<Badge> & { error?: string };

      if (res.status === 404) {
        setTrouble({
          title: `Badge ${id} is not a membership`,
          body: "Nobody at this organization holds that badge. Check you scanned your own, or ask an organizer to onboard you at the desk.",
        });
        return;
      }
      if (res.status === 502) {
        setTrouble({
          title: "That badge could not be checked",
          body: "The chain did not answer, so this is not a refusal. Wait a moment and scan again.",
        });
        return;
      }
      if (!res.ok) {
        setTrouble({
          title: "This portal is not set up",
          body: `${body.error ?? "The portal could not look up a badge."} An organizer has to fix this — scanning again will not help.`,
        });
        return;
      }

      setBadge(body as Badge);
      setStep("wallet");
    } catch {
      setTrouble({
        title: "The portal did not answer",
        body: "Nothing could be looked up from this device. Stay on the network and try again.",
      });
    } finally {
      setBusy("");
    }
  }

  async function signIn() {
    if (!badge || !address) return;
    const mine = ++attempt.current;
    const live = () => attempt.current === mine;
    setBusy("sign");
    setTrouble(null);
    setStep("sign");
    try {
      // Always a fresh challenge, worded by the server. The nonce is spent by any attempt that
      // reaches `verify`, and one abandoned in the wallet is simply left to expire.
      let nonce: string;
      let message: string;
      try {
        const res = await fetch("/api/portal/challenge", { method: "POST", cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        ({ nonce, message } = (await res.json()) as { nonce: string; message: string });
      } catch {
        if (!live()) return;
        setStep("wallet");
        setTrouble({
          title: "The portal did not answer",
          body: "It could not issue a challenge to sign. Stay on this network and try again.",
        });
        return;
      }

      let signature: string;
      try {
        signature = await signMessageAsync({ message });
      } catch (error) {
        if (!live()) return;
        setStep("wallet");
        const name = error instanceof Error ? error.name : "";
        setTrouble(
          name === "UserRejectedRequestError"
            ? {
                title: "You declined the signature",
                body: "Nothing was signed, so nothing was proved. Tap sign again and approve the request in your wallet — it is a signature, not a transaction, and costs nothing.",
              }
            : {
                title: "Your wallet could not sign",
                body: error instanceof Error ? error.message : "The wallet returned no signature.",
              },
        );
        return;
      }

      const res = await fetch("/api/portal/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          nonce,
          signature,
          wallet_address: address,
          ens_name: badge.name,
        }),
      });
      const result = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        admitted?: boolean;
        admissionError?: string;
        admissionKind?: string | null;
        reason?: string;
        ens_name?: string;
        group_name?: string;
        role?: string;
      };

      if (!live()) return;
      if (!result.ok) {
        setStep("wallet");
        setTrouble(refusal(res.status, result.reason));
        return;
      }

      // Identified is not admitted. The signature check happens here; the firewall rule happens
      // on the branch host, and the page must never claim the second because the first passed.
      if (!result.admitted) {
        setStep("wallet");
        setTrouble(notAdmitted(result.admissionKind ?? null, result.admissionError));
        return;
      }

      setGrant([
        ...(badge.displayName ? ([["Member", badge.displayName]] as [string, string][]) : []),
        ["Badge", badge.id],
        ["Membership", result.ens_name ?? badge.name],
        ["Group", result.group_name ?? badge.role],
        ["Wallet", short(address)],
      ]);
      setAlreadyOnline(false);
      setStep("online");
    } finally {
      if (live()) setBusy("");
    }
  }

  /** Abandon whatever is in flight and go back to a named screen. */
  function abandon(to: Step) {
    attempt.current += 1;
    setBusy("");
    setTrouble(null);
    if (to === "badge") {
      setBadge(null);
      setGrant([]);
      setAlreadyOnline(false);
    }
    setStep(to);
  }

  const current = STEPS.findIndex((s) => s.key === step);

  return (
    <div className="mx-auto w-full max-w-[420px]">
      <section className="rounded-sharp border border-rule bg-paper-raise">
        <header className="flex items-baseline justify-between gap-3 border-b border-rule px-4 py-3">
          <p className="truncate font-mono text-xs text-ink">
            {process.env.NEXT_PUBLIC_SSID ?? "the branch network"}
          </p>
          <p className="label shrink-0">SSID</p>
        </header>

        <div className="relative h-16 border-b border-rule">
          <SignalDither
            motif="ripple"
            cell={2}
            period={3.4}
            intensity={0.7}
            className="absolute inset-0"
            label="Beacon signal from the branch access point"
          />
        </div>

        <ol
          aria-label="Progress"
          className="flex items-center gap-1.5 border-b border-rule px-4 py-2 font-mono text-[0.625rem] uppercase tracking-[0.12em]"
        >
          {STEPS.map((s, i) => (
            <li
              key={s.key}
              aria-current={i === current ? "step" : undefined}
              className={`flex items-center gap-1.5 ${
                i === current ? "text-ink" : i < current ? "text-ink-muted" : "text-ink-faint"
              }`}
            >
              {i > 0 ? (
                <span aria-hidden className="text-ink-faint">
                  ·
                </span>
              ) : null}
              {s.label}
            </li>
          ))}
        </ol>

        <div className="relative overflow-hidden">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={step}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: reduceMotion ? 0 : 0.18 }}
              className="px-4 py-5"
            >
              {step === "badge" ? (
                <>
                  <h1 className="text-lg leading-snug tracking-[-0.01em] text-ink">
                    Scan your badge
                  </h1>
                  <p className="mt-2 text-sm leading-relaxed text-ink-muted">
                    Point the camera at the code on your lanyard. Then sign with the wallet it was
                    registered to — a signature only, no transaction and no password.
                  </p>
                  <Button
                    variant="solid"
                    className="mt-6 w-full"
                    onClick={() => setScanning(true)}
                    disabled={busy === "badge"}
                  >
                    {busy === "badge" ? "Checking…" : "Scan my badge"}
                  </Button>
                </>
              ) : null}

              {step === "wallet" && badge ? (
                <>
                  <h1 className="text-lg leading-snug tracking-[-0.01em] text-ink">
                    {walletMatches ? "Sign to get online" : "Connect the badge's wallet"}
                  </h1>
                  <dl className="mt-4 divide-y divide-rule border-y border-rule">
                    {badge.displayName ? <Row term="Member" detail={badge.displayName} /> : null}
                    <Row term="Badge" detail={badge.id} />
                    <Row term="Membership" detail={badge.name} />
                    <Row term="Registered to" detail={short(badge.wallet)} />
                  </dl>

                  {!isConnected ? (
                    usable.length === 0 ? (
                      <p className="mt-4 text-sm leading-relaxed text-ink-muted">
                        There is no wallet in this browser. Captive-portal windows cannot reach
                        one. Open <span className="font-mono text-xs text-ink">this page</span> in
                        your wallet app&rsquo;s own browser, or finish joining the network on a
                        phone that has the wallet installed.
                      </p>
                    ) : (
                      <>
                        <p className="mt-4 text-sm leading-relaxed text-ink-muted">
                          Connect the wallet this badge was registered to. Any other wallet will be
                          refused, so there is nothing to lose by trying.
                        </p>
                        <div className="mt-5 flex flex-col gap-2">
                          {usable.map((connector) => (
                            <Button
                              key={connector.uid}
                              variant="solid"
                              className="w-full"
                              onClick={() => connect({ connector })}
                              disabled={connecting}
                            >
                              {connecting ? "Connecting…" : `Connect ${connector.name}`}
                            </Button>
                          ))}
                        </div>
                        {connectError ? (
                          <p className="mt-3 text-xs leading-relaxed" style={{ color: "var(--alert)" }}>
                            {connectError.message}
                          </p>
                        ) : null}
                      </>
                    )
                  ) : !walletMatches ? (
                    <>
                      <p className="label mt-4" style={{ color: "var(--alert)" }}>
                        Wrong wallet
                      </p>
                      <p className="mt-2 text-sm leading-relaxed text-ink-muted">
                        This badge belongs to a different wallet. It is registered to{" "}
                        <span className="font-mono text-xs text-ink">{short(badge.wallet)}</span>,
                        and you are connected as{" "}
                        <span className="font-mono text-xs text-ink">
                          {address ? short(address) : "—"}
                        </span>
                        . Disconnect and connect that one, or scan your own badge.
                      </p>
                      <div className="mt-5 flex flex-col gap-2">
                        <Button variant="solid" className="w-full" onClick={() => disconnect()}>
                          Disconnect
                        </Button>
                        <Button variant="outline" className="w-full" onClick={() => abandon("badge")}>
                          Scan another badge
                        </Button>
                      </div>
                    </>
                  ) : (
                    <>
                      <p className="mt-4 text-sm leading-relaxed text-ink-muted">
                        Connected as{" "}
                        <span className="font-mono text-xs text-ink">
                          {address ? short(address) : ""}
                        </span>
                        , which is the wallet on this badge. Sign the challenge to prove you hold
                        it and the branch will let this device through.
                      </p>
                      <div className="mt-5 flex flex-col gap-2">
                        <Button
                          variant="solid"
                          className="w-full"
                          onClick={signIn}
                          disabled={busy === "sign"}
                        >
                          Sign and get online
                        </Button>
                        <Button variant="ghost" className="w-full" onClick={() => abandon("badge")}>
                          Scan another badge
                        </Button>
                      </div>
                    </>
                  )}
                </>
              ) : null}

              {step === "sign" ? (
                <>
                  <h1 className="text-lg leading-snug tracking-[-0.01em] text-ink">
                    Check your wallet
                  </h1>
                  <p className="mt-2 text-sm leading-relaxed text-ink-muted">
                    Approve the signature request. It proves you hold{" "}
                    <span className="font-mono text-xs text-ink">{badge?.name}</span> and moves no
                    funds.
                  </p>
                  <Button variant="outline" className="mt-6 w-full" onClick={() => abandon("wallet")}>
                    Cancel
                  </Button>
                </>
              ) : null}

              {step === "online" ? (
                <>
                  <p className="label flex items-center gap-2">
                    <span
                      aria-hidden
                      className="size-1.5 rounded-full"
                      style={{ background: "var(--signal)" }}
                    />
                    Admitted
                  </p>
                  <h1 className="mt-3 text-lg leading-snug tracking-[-0.01em] text-ink">
                    {alreadyOnline ? "This device is already online" : "You are online"}
                  </h1>
                  <p className="mt-2 text-sm leading-relaxed text-ink-muted">
                    {alreadyOnline
                      ? "It was admitted earlier and the branch is still letting it through. There is nothing to scan — close this page and carry on browsing."
                      : "Your wallet signed for this badge and the branch opened the network for this device. Close this page and carry on browsing."}
                  </p>
                  {grant.length > 0 ? (
                    <dl className="mt-5 divide-y divide-rule border-y border-rule">
                      {grant.map(([term, detail]) => (
                        <Row key={term} term={term} detail={detail} />
                      ))}
                    </dl>
                  ) : null}
                  <Button variant="ghost" className="mt-5 w-full" onClick={() => abandon("badge")}>
                    Sign in as someone else
                  </Button>
                </>
              ) : null}

              {trouble ? (
                <div className="mt-5 border-t border-rule pt-4" role="status">
                  <p className="label" style={{ color: "var(--alert)" }}>
                    {trouble.title}
                  </p>
                  <p className="mt-2 text-sm leading-relaxed text-ink-muted">{trouble.body}</p>
                </div>
              ) : null}
            </motion.div>
          </AnimatePresence>
        </div>
      </section>

      {scanning ? (
        <QrScanner
          confirmTitle="Is this your badge?"
          confirmNote="Check it against the code on your lanyard — the network will only admit the wallet this badge was registered to."
          confirmLabel="This is mine"
          onScanned={lookUpBadge}
          onClose={() => setScanning(false)}
        />
      ) : null}
    </div>
  );
}

/** `window.ethereum` never changes after load, so there is nothing to subscribe to. */
function subscribeNothing() {
  return () => {};
}

function hasInjectedWallet(): boolean {
  return Boolean((window as unknown as { ethereum?: unknown }).ethereum);
}

function Row({ term, detail }: { term: string; detail: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2">
      <dt className="label shrink-0">{term}</dt>
      <dd className="truncate text-right font-mono text-xs text-ink-80">{detail}</dd>
    </div>
  );
}

/**
 * What `verify` refused, in words. The status code carries the distinction that matters: 401 is
 * the challenge, 403 is a decision about this membership, 502 is a chain that did not answer —
 * and that last one must never be worded as a refusal.
 */
function refusal(status: number, reason?: string): Trouble {
  if (status === 401) {
    return {
      title: "That signature was not accepted",
      body: `${reason ?? "The challenge did not check out."} Challenges are good once and expire quickly — sign again for a fresh one.`,
    };
  }
  if (status === 403) {
    return {
      title: "That badge is not admitted here",
      body: `${reason ?? "The membership was refused."} Ask an organizer to check your membership at the desk.`,
    };
  }
  if (status === 502) {
    return {
      title: "Your membership could not be checked",
      body: "The chain did not answer, so this is not a refusal and you have not been turned away. Try again in a moment.",
    };
  }
  if (status === 503) {
    return {
      title: "This portal is not set up",
      body: `${reason ?? "The portal is misconfigured."} An organizer has to fix this — signing again will not help.`,
    };
  }
  return {
    title: "Sign-in did not complete",
    body: reason ?? `The portal answered ${status} and said nothing more.`,
  };
}

/**
 * Verified but not on the network. Everything here is somebody else's outage, not the guest's
 * fault, and saying "you are not allowed" would send them to argue with an organizer about a
 * daemon that is simply down.
 */
function notAdmitted(kind: string | null, detail?: string): Trouble {
  if (kind === "unreachable" || kind === "no-address") {
    return {
      title: "The network gate did not answer",
      body: `Your membership checks out, so this is not a refusal — the branch enforcer is unreachable from this device${
        detail ? ` (${detail})` : ""
      }. Try again; if it keeps happening, tell an organizer the portal daemon is down.`,
    };
  }
  if (kind === "unconfigured") {
    return {
      title: "This portal has no enforcer",
      body: "Your membership checks out, but this portal is not wired to a branch that can open the network. An organizer has to fix this.",
    };
  }
  return {
    title: "The branch refused this device",
    body: `Your membership checks out, but the enforcer would not open the network${
      detail ? `: ${detail}` : ""
    }. Ask an organizer what this branch allows your group.`,
  };
}
