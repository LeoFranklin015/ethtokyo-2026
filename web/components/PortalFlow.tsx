"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useState } from "react";
import { SignalDither } from "@/components/dither/SignalDither";
import { Button } from "@/components/ui/Button";

type State = "idle" | "signing" | "connected" | "denied";

const ORDER: State[] = ["idle", "signing", "connected", "denied"];

const COPY: Record<State, { label: string; title: string; body: string }> = {
  idle: {
    label: "Not admitted",
    title: "Sign in to the network",
    body: "Connect the wallet that holds your membership. Nothing leaves this device but a signature.",
  },
  signing: {
    label: "Verifying",
    title: "Check your wallet",
    body: "Sign the challenge to prove you hold leo.tokyo2026.ethglobal.eth.",
  },
  connected: {
    label: "Admitted",
    title: "You are online",
    body: "Your role resolved to hacker. Entitlements were applied to this device.",
  },
  denied: {
    label: "Refused",
    title: "No membership here",
    body: "That wallet holds no membership at this branch and no organization-scoped role.",
  },
};

export function PortalFlow() {
  const [state, setState] = useState<State>("idle");
  const [direction, setDirection] = useState(1);
  const reduceMotion = useReducedMotion();

  // The signing state is transient — it resolves on its own, like the real flow.
  useEffect(() => {
    if (state !== "signing") return;
    const timer = setTimeout(() => {
      setDirection(1);
      setState("connected");
    }, 1600);
    return () => clearTimeout(timer);
  }, [state]);

  function go(next: State) {
    setDirection(ORDER.indexOf(next) >= ORDER.indexOf(state) ? 1 : -1);
    setState(next);
  }

  const copy = COPY[state];
  const slide = reduceMotion ? 0 : 28;

  return (
    <div className="mx-auto w-full max-w-[420px]">
      <div className="relative border border-ink/45 paper-grid">
        <div className="relative h-[190px] border-b border-ink/20">
          <SignalDither
            motif="ripple"
            cell={3}
            period={3.4}
            className="absolute inset-0"
            label="Beacon signal from the branch access point"
          />
        </div>

        <div className="relative overflow-hidden">
          <AnimatePresence mode="wait" initial={false} custom={direction}>
            <motion.div
              key={state}
              custom={direction}
              initial={{ opacity: 0, x: direction * slide }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: direction * -slide }}
              transition={{ duration: reduceMotion ? 0 : 0.26, ease: [0.22, 1, 0.36, 1] }}
              className="px-6 py-6"
            >
              <p
                className="label flex items-center gap-2"
                style={{ color: state === "denied" ? "var(--alert)" : undefined }}
                role="status"
              >
                <span
                  aria-hidden
                  className="size-1.5 rounded-full"
                  style={{
                    background:
                      state === "connected"
                        ? "var(--signal)"
                        : state === "denied"
                          ? "var(--alert)"
                          : "var(--ink-faint)",
                  }}
                />
                {copy.label}
              </p>

              <h1 className="mt-3 text-xl leading-snug text-ink">{copy.title}</h1>
              <p className="mt-2 text-sm leading-relaxed text-ink-muted">{copy.body}</p>

              {state === "connected" ? (
                <dl className="mt-5 divide-y divide-rule border-y border-rule">
                  {[
                    ["Membership", "leo.tokyo2026.ethglobal.eth"],
                    ["Role", "hacker"],
                    ["Group", "hacker · vlan 100"],
                    ["Rate", "5 / 20 Mbps"],
                  ].map(([term, detail]) => (
                    <div key={term} className="flex items-baseline justify-between gap-3 py-2">
                      <dt className="label">{term}</dt>
                      <dd className="text-right font-mono text-xs text-ink-80">{detail}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}

              <div className="mt-6 flex flex-wrap gap-2">
                {state === "idle" ? (
                  <Button variant="solid" onClick={() => go("signing")}>
                    Connect wallet
                  </Button>
                ) : null}
                {state === "signing" ? (
                  <Button variant="outline" onClick={() => go("idle")}>
                    Cancel
                  </Button>
                ) : null}
                {state === "connected" ? (
                  <Button variant="outline" onClick={() => go("idle")}>
                    Disconnect
                  </Button>
                ) : null}
                {state === "denied" ? (
                  <Button variant="solid" onClick={() => go("idle")}>
                    Try another wallet
                  </Button>
                ) : null}
              </div>
            </motion.div>
          </AnimatePresence>
        </div>
      </div>

      <fieldset className="mt-6 border-t border-rule pt-4">
        <legend className="sr-only">Preview a portal state</legend>
        <p className="label mb-2">Preview state</p>
        <div className="flex flex-wrap gap-1.5">
          {ORDER.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => go(s)}
              aria-pressed={state === s}
              className={`inline-flex min-h-11 items-center rounded-full border px-4 font-mono text-[0.6875rem] uppercase tracking-[0.1em] transition-colors ${
                state === s
                  ? "border-ink bg-ink text-paper"
                  : "border-rule text-ink-muted hover:border-ink hover:text-ink"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </fieldset>
    </div>
  );
}
