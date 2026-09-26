"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Panel, PanelHeader } from "@/components/ui/Panel";

type Availability = {
  valid: boolean;
  reason?: string;
  label?: string;
  name?: string;
  available?: boolean;
  priceFormatted?: string;
};

type Phase = "idle" | "checking" | "committing" | "waiting" | "registering" | "done" | "error";

/**
 * Claiming the organization's `.eth` name.
 *
 * ENS registration is deliberately two steps with a delay between them: you publish a commitment,
 * wait, then reveal it. The wait is what stops someone watching the mempool from registering the
 * name out from under you, so the UI shows it as a real stage rather than hiding it behind a
 * spinner.
 */
export function OrgSetup() {
  const [label, setLabel] = useState("");
  const [check, setCheck] = useState<Availability | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [countdown, setCountdown] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [signer, setSigner] = useState<{ configured: boolean; signer: string | null } | null>(null);

  useEffect(() => {
    fetch("/api/ens/org")
      .then((r) => r.json())
      .then(setSigner)
      .catch(() => setSigner({ configured: false, signer: null }));
  }, []);

  // Debounced availability lookup as the name is typed.
  useEffect(() => {
    const value = label.trim().toLowerCase();
    if (!value) {
      setCheck(null);
      return;
    }
    setPhase("checking");
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/ens/available?label=${encodeURIComponent(value)}`);
        setCheck(await res.json());
      } catch {
        setCheck({ valid: false, reason: "could not reach the registrar" });
      } finally {
        setPhase("idle");
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [label]);

  useEffect(() => {
    if (phase !== "waiting" || countdown <= 0) return;
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [phase, countdown]);

  async function post(step: "commit" | "register") {
    const res = await fetch("/api/ens/org", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ step, label: label.trim().toLowerCase() }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `step ${step} failed`);
    return body;
  }

  async function commit() {
    setPhase("committing");
    setMessage(null);
    try {
      const { readyInSeconds, alreadyCommitted } = await post("commit");
      setCountdown(readyInSeconds);
      setPhase("waiting");
      setMessage(
        alreadyCommitted
          ? "A commitment for this name already exists — waiting for it to mature."
          : null,
      );
    } catch (e) {
      setPhase("error");
      setMessage(e instanceof Error ? e.message : "commit failed");
    }
  }

  async function register() {
    setPhase("registering");
    setMessage(null);
    try {
      const { name } = await post("register");
      setPhase("done");
      setMessage(`${name} is yours. Set it as the organization and open a branch.`);
    } catch (e) {
      setPhase("error");
      setMessage(e instanceof Error ? e.message : "registration failed");
    }
  }

  const busy = phase === "committing" || phase === "registering";
  const canCommit = check?.valid && check.available && !busy && signer?.configured;

  return (
    <Panel as="section">
      <PanelHeader
        right={
          signer ? (
            <span className="font-mono text-[0.6875rem] text-ink-muted">
              {signer.configured
                ? `signs as ${signer.signer?.slice(0, 10)}…`
                : "no signing key configured"}
            </span>
          ) : null
        }
      >
        Claim the organization name
      </PanelHeader>

      <div className="px-4 py-5">
        <label htmlFor="org-label" className="label">
          Organization
        </label>
        <div className="mt-2 flex items-center gap-2">
          <input
            id="org-label"
            value={label}
            onChange={(e) => setLabel(e.target.value.replace(/[^a-zA-Z0-9-]/g, "").toLowerCase())}
            placeholder="acme"
            autoComplete="off"
            spellCheck={false}
            className="h-11 min-w-0 flex-1 rounded-sharp border border-rule bg-paper px-3 font-mono text-sm text-ink placeholder:text-ink-faint"
          />
          <span className="shrink-0 font-mono text-sm text-ink-muted">.eth</span>
        </div>

        <div className="mt-3 min-h-[1.5rem]" role="status" aria-live="polite">
          {phase === "checking" ? (
            <p className="font-mono text-xs text-ink-muted">checking…</p>
          ) : check && !check.valid ? (
            <p className="font-mono text-xs" style={{ color: "var(--alert)" }}>
              {check.reason}
            </p>
          ) : check?.available ? (
            <p className="font-mono text-xs text-ink-80">
              <span style={{ color: "var(--signal)" }}>{check.name} is available</span> ·{" "}
              {check.priceFormatted} for one year
            </p>
          ) : check ? (
            <p className="font-mono text-xs" style={{ color: "var(--alert)" }}>
              {check.name} is already registered
            </p>
          ) : null}
        </div>

        {/* The two-step registration, shown as two steps. */}
        <ol className="mt-5 divide-y divide-rule border-y border-rule">
          <Step
            n={1}
            title="Commit"
            detail="Approve payment and publish a commitment nobody can read."
            state={
              phase === "committing"
                ? "active"
                : ["waiting", "registering", "done"].includes(phase)
                  ? "done"
                  : "todo"
            }
          />
          <Step
            n={2}
            title="Wait"
            detail={
              phase === "waiting" && countdown > 0
                ? `${countdown}s — the delay is what prevents front-running.`
                : "ENS enforces a delay before the commitment can be revealed."
            }
            state={
              phase === "waiting"
                ? "active"
                : ["registering", "done"].includes(phase)
                  ? "done"
                  : "todo"
            }
          />
          <Step
            n={3}
            title="Register"
            detail="Reveal the commitment and take the name."
            state={phase === "registering" ? "active" : phase === "done" ? "done" : "todo"}
          />
        </ol>

        {message ? (
          <p
            className="mt-4 text-xs leading-relaxed"
            style={{ color: phase === "error" ? "var(--alert)" : "var(--ink-muted)" }}
            role="status"
          >
            {message}
          </p>
        ) : null}

        <div className="mt-5 flex flex-wrap gap-2">
          <Button variant="solid" onClick={commit} disabled={!canCommit}>
            {phase === "committing" ? "Committing…" : "Commit"}
          </Button>
          <Button
            variant="outline"
            onClick={register}
            disabled={phase !== "waiting" || countdown > 0 || busy}
          >
            {phase === "registering" ? "Registering…" : "Register"}
          </Button>
        </div>

        {signer && !signer.configured ? (
          <p className="mt-4 text-xs leading-relaxed text-ink-muted">
            Set <code className="font-mono">ORG_PRIVATE_KEY</code> for the console to sign
            organization transactions. Availability and pricing work without it.
          </p>
        ) : null}
      </div>
    </Panel>
  );
}

function Step({
  n,
  title,
  detail,
  state,
}: {
  n: number;
  title: string;
  detail: string;
  state: "todo" | "active" | "done";
}) {
  const colour =
    state === "done" ? "var(--signal)" : state === "active" ? "var(--ink)" : "var(--ink-faint)";
  return (
    <li className="flex items-start gap-3 py-3">
      <span
        aria-hidden
        className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border font-mono text-[0.6875rem]"
        style={{ borderColor: colour, color: colour }}
      >
        {state === "done" ? "✓" : n}
      </span>
      <span className="min-w-0">
        <span className="block font-mono text-xs text-ink">{title}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-ink-muted">{detail}</span>
      </span>
    </li>
  );
}
