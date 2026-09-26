"use client";

/** The slice of EIP-1193 this flow uses. viem's own type over-constrains `personal_sign`. */
type WalletProvider = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useState } from "react";
import { SignalDither } from "@/components/dither/SignalDither";
import { Button } from "@/components/ui/Button";

type State = "idle" | "signing" | "connected" | "denied";

const ORDER: State[] = ["idle", "signing", "connected", "denied"];

const COPY: Record<State, { status: string; title: string; body: string }> = {
  idle: {
    status: "Not admitted",
    title: "Sign in to the network",
    body: "Connect the wallet holding your membership. Only a signature leaves this device — no password, no account.",
  },
  signing: {
    status: "Verifying",
    title: "Check your wallet",
    body: "Sign the challenge to prove control of your membership name.",
  },
  connected: {
    status: "Admitted",
    title: "You are online",
    body: "Your role resolved and its entitlements were applied to this device.",
  },
  denied: {
    status: "Refused",
    title: "No membership at this branch",
    body: "That wallet holds no membership here. Ask an organizer to onboard you.",
  },
};

type GrantInfo = [string, string][];

// Portal runs at the same origin as the captive page (port 8080).
// In SSR there is no window; fall back to empty string — fetch calls only run client-side.
const PORTAL_ORIGIN = typeof window !== "undefined" ? window.location.origin : "";

export function PortalFlow() {
  const [state, setState] = useState<State>("idle");
  const [direction, setDirection] = useState(1);
  const [grant, setGrant] = useState<GrantInfo>([]);
  const [error, setError] = useState<string>("");
  const reduceMotion = useReducedMotion();

  function go(next: State) {
    setDirection(ORDER.indexOf(next) >= ORDER.indexOf(state) ? 1 : -1);
    setState(next);
  }

  async function connectWallet() {
    setError("");
    go("signing");
    try {
      const eth = (window as unknown as { ethereum?: WalletProvider }).ethereum;
      if (!eth) {
        throw new Error("No Ethereum wallet found. Install MetaMask or a compatible wallet.");
      }

      // Request accounts — prompts MetaMask if not already connected
      const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
      const address = accounts[0]?.toLowerCase();
      if (!address) throw new Error("No account selected.");

      // Fetch a one-time challenge nonce from the portal
      const challengeRes = await fetch(`${PORTAL_ORIGIN}/wallet-challenge`);
      if (!challengeRes.ok) throw new Error("Portal unreachable.");
      const { nonce } = await challengeRes.json() as { nonce: string };

      // EIP-191 personal_sign: sign the challenge message
      const message = `Sign in to ENSCA\nNonce: ${nonce}`;
      let signature: string;
      try {
        signature = (await eth.request({
          method: "personal_sign",
          params: [message, address],
        })) as string;
      } catch (err) {
        // 4001 is the wallet's "user rejected" code.
        if ((err as { code?: number })?.code === 4001) {
          // User rejected the signature request in MetaMask
          go("denied");
          setError("Signature request was rejected.");
          return;
        }
        throw err;
      }

      // Submit nonce + signature to portal for server-side verification
      const verifyRes = await fetch(`${PORTAL_ORIGIN}/wallet-verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nonce, signature, wallet_address: address }),
      });
      const result = await verifyRes.json() as {
        ok: boolean;
        reason?: string;
        ens_name?: string;
        group_name?: string;
        tier?: string;
        wallet_address?: string;
      };

      if (!result.ok) {
        setError(result.reason ?? "Unknown error");
        go("denied");
        return;
      }

      setGrant([
        ["Membership", result.ens_name ?? address],
        ["Group",      result.group_name ?? result.tier ?? "—"],
        ["Tier",       result.tier ?? "—"],
        ["Wallet",     `${address.slice(0, 6)}…${address.slice(-4)}`],
      ]);
      go("connected");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      go("denied");
    }
  }

  const copy = COPY[state];
  const slide = reduceMotion ? 0 : 20;
  const accent =
    state === "connected"
      ? "var(--signal)"
      : state === "denied"
        ? "var(--alert)"
        : "var(--ink-faint)";

  return (
    <div className="w-full max-w-[400px]">
      <section className="rounded-sharp border border-rule bg-paper-raise">
        <header className="flex items-baseline justify-between gap-3 border-b border-rule px-5 py-3">
          <p className="truncate font-mono text-xs text-ink">
            {process.env.NEXT_PUBLIC_SSID ?? "ensca"}
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

        <div className="relative overflow-hidden">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={state}
              initial={{ opacity: 0, x: direction * slide }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: direction * -slide }}
              transition={{ duration: reduceMotion ? 0 : 0.24, ease: [0.22, 1, 0.36, 1] }}
              className="px-5 py-5"
            >
              <p className="label flex items-center gap-2">
                <span aria-hidden className="size-1.5 rounded-full" style={{ background: accent }} />
                {copy.status}
              </p>
              <h1 className="mt-3 text-lg leading-snug tracking-[-0.01em] text-ink">{copy.title}</h1>
              <p className="mt-2 text-sm leading-relaxed text-ink-muted">{copy.body}</p>

              {state === "connected" && grant.length > 0 && (
                <dl className="mt-5 divide-y divide-rule border-y border-rule">
                  {grant.map(([term, detail]) => (
                    <div key={term} className="flex items-baseline justify-between gap-3 py-2">
                      <dt className="label">{term}</dt>
                      <dd className="text-right font-mono text-xs text-ink-80">{detail}</dd>
                    </div>
                  ))}
                </dl>
              )}

              {state === "denied" && error && (
                <p className="mt-3 font-mono text-xs text-alert">{error}</p>
              )}

              <div className="mt-6">
                {state === "idle" && (
                  <Button variant="solid" className="w-full" onClick={connectWallet}>
                    Connect wallet
                  </Button>
                )}
                {state === "signing" && (
                  <Button variant="outline" className="w-full" onClick={() => go("idle")}>
                    Cancel
                  </Button>
                )}
                {state === "connected" && (
                  <Button variant="outline" className="w-full" onClick={() => go("idle")}>
                    Disconnect
                  </Button>
                )}
                {state === "denied" && (
                  <Button variant="solid" className="w-full" onClick={() => go("idle")}>
                    Try another wallet
                  </Button>
                )}
              </div>
            </motion.div>
          </AnimatePresence>
        </div>
      </section>
    </div>
  );
}
