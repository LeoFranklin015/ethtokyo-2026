"use client";

import { useEffect, useState } from "react";
import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { sepolia } from "wagmi/chains";
import Link from "next/link";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Panel } from "@/components/ui/Panel";
import { SignalDither } from "@/components/dither/SignalDither";

/**
 * Creating an organization, as one guided flow.
 *
 * The four steps are not an arbitrary wizard — they are the layers of the domain model, in the
 * only order they can be built: an organization owns a name, a branch lives under that name, a
 * group is a category defined by a branch, and a person is onboarded into a group. Each step is
 * only reachable once the thing it depends on exists.
 */

type StepId = "connect" | "name" | "branch" | "groups" | "done";

const STEPS: { id: StepId; title: string; blurb: string }[] = [
  { id: "connect", title: "Wallet", blurb: "Connect the wallet that will own the organization." },
  { id: "name", title: "Name", blurb: "Claim the .eth name the organization is built on." },
  { id: "branch", title: "Branch", blurb: "Open a location. It gets its own registry." },
  { id: "groups", title: "Groups", blurb: "Define the categories people are onboarded into." },
  { id: "done", title: "Open", blurb: "Start admitting people." },
];

export function Wizard() {
  const [step, setStep] = useState<StepId>("connect");
  const [orgName, setOrgName] = useState<string | null>(null);
  const [branchLabel, setBranchLabel] = useState<string | null>(null);
  const [registrar, setRegistrar] = useState<string | null>(null);

  const index = STEPS.findIndex((s) => s.id === step);

  return (
    <div className="grid gap-8 lg:grid-cols-[220px_1fr] lg:gap-12">
      <Rail steps={STEPS} current={index} />

      <div className="min-w-0">
        {step === "connect" ? <ConnectStep onDone={() => setStep("name")} /> : null}

        {step === "name" ? (
          <NameStep
            onDone={(name) => {
              setOrgName(name);
              setStep("branch");
            }}
          />
        ) : null}

        {step === "branch" ? (
          <BranchStep
            onDone={(label, reg) => {
              setBranchLabel(label);
              setRegistrar(reg);
              setStep("groups");
            }}
            onSkip={() => setStep("groups")}
          />
        ) : null}

        {step === "groups" ? (
          <GroupsStep registrar={registrar} onDone={() => setStep("done")} />
        ) : null}

        {step === "done" ? <DoneStep org={orgName} branch={branchLabel} /> : null}
      </div>
    </div>
  );
}

function Rail({ steps, current }: { steps: typeof STEPS; current: number }) {
  return (
    <ol className="flex gap-4 overflow-x-auto lg:block lg:overflow-visible">
      {steps.map((s, i) => {
        const state = i < current ? "done" : i === current ? "active" : "todo";
        const colour =
          state === "done"
            ? "var(--signal)"
            : state === "active"
              ? "var(--ink)"
              : "var(--ink-faint)";
        return (
          <li key={s.id} className="flex min-w-[150px] gap-3 lg:min-w-0 lg:pb-6">
            <span className="flex flex-col items-center">
              <span
                aria-hidden
                className="grid size-6 shrink-0 place-items-center rounded-full border font-mono text-[0.6875rem]"
                style={{ borderColor: colour, color: colour }}
              >
                {state === "done" ? "✓" : i + 1}
              </span>
              {i < steps.length - 1 ? (
                <span
                  aria-hidden
                  className="mt-1 hidden w-px flex-1 lg:block"
                  style={{ background: i < current ? "var(--signal)" : "var(--rule)" }}
                />
              ) : null}
            </span>
            <span className="min-w-0 pb-1">
              <span
                className="block font-mono text-xs"
                style={{ color: state === "todo" ? "var(--ink-muted)" : "var(--ink)" }}
              >
                {s.title}
              </span>
              <span className="mt-0.5 block text-xs leading-relaxed text-ink-muted">
                {s.blurb}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

////////////////////////////////////////////////////////////////////////
// Step 0 — the wallet
////////////////////////////////////////////////////////////////////////

function short(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Connecting the wallet.
 *
 * This is first because an organization is a name somebody owns. The address connected here
 * becomes the `owner` of the .eth name and of every branch registry beneath it — the server's
 * key signs and pays the registration, but it never holds the name.
 */
function ConnectStep({ onDone }: { onDone: () => void }) {
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();

  const wrongChain = isConnected && chainId !== sepolia.id;

  return (
    <Panel as="section">
      <div className="px-5 py-6">
        <h2 className="text-lg tracking-[-0.01em] text-ink">Connect a wallet</h2>
        <p className="mt-2 max-w-[54ch] text-sm leading-relaxed text-ink-muted">
          This wallet owns the organization. It holds the .eth name, root of every branch registry
          beneath it, and the authority to open branches later. Nothing here spends from it — the
          console signs and pays for registration.
        </p>

        {!isConnected ? (
          <div className="mt-5 space-y-2">
            {connectors.map((c) => (
              <Button
                key={c.uid}
                variant="solid"
                onClick={() => connect({ connector: c })}
                disabled={isPending}
              >
                {isPending ? "Connecting…" : c.name}
              </Button>
            ))}
            {connectors.length === 0 ? (
              <p className="text-xs leading-relaxed" style={{ color: "var(--alert)" }}>
                No connectors are configured. Set NEXT_PUBLIC_REOWN_PROJECT_ID to enable
                WalletConnect, or install a browser wallet.
              </p>
            ) : null}
          </div>
        ) : (
          <div className="mt-5 space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <span
                aria-hidden
                className="size-1.5 rounded-full"
                style={{ background: wrongChain ? "var(--alert)" : "var(--signal)" }}
              />
              <span className="font-mono text-sm text-ink">{short(address!)}</span>
              <button
                type="button"
                onClick={() => disconnect()}
                className="font-mono text-[0.6875rem] text-ink-muted underline decoration-rule underline-offset-2 hover:text-ink"
              >
                disconnect
              </button>
            </div>

            {wrongChain ? (
              <div className="space-y-2">
                <p className="text-xs leading-relaxed" style={{ color: "var(--alert)" }}>
                  This wallet is on another network. Every ENSCA contract is deployed on Sepolia.
                </p>
                <Button
                  variant="solid"
                  onClick={() => switchChain({ chainId: sepolia.id })}
                  disabled={switching}
                >
                  {switching ? "Switching…" : "Switch to Sepolia"}
                </Button>
              </div>
            ) : (
              <Button variant="solid" onClick={onDone}>
                Continue
              </Button>
            )}
          </div>
        )}

        {error ? (
          <p className="mt-3 text-xs leading-relaxed" style={{ color: "var(--alert)" }} role="status">
            {error.message}
          </p>
        ) : null}
      </div>
    </Panel>
  );
}

////////////////////////////////////////////////////////////////////////
// Step 1 — the organization name
////////////////////////////////////////////////////////////////////////

function NameStep({ onDone }: { onDone: (name: string) => void }) {
  const { address } = useAccount();
  const [label, setLabel] = useState("");
  const [check, setCheck] = useState<{
    valid: boolean;
    reason?: string;
    name?: string;
    available?: boolean;
    priceFormatted?: string;
  } | null>(null);
  const [phase, setPhase] = useState<"idle" | "committing" | "waiting" | "registering" | "error">(
    "idle",
  );
  const [countdown, setCountdown] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [signer, setSigner] = useState<{ configured: boolean } | null>(null);

  useEffect(() => {
    fetch("/api/ens/org")
      .then((r) => r.json())
      .then(setSigner)
      .catch(() => setSigner({ configured: false }));
  }, []);

  useEffect(() => {
    const value = label.trim().toLowerCase();
    if (!value) return;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/ens/available?label=${value}`);
        if (!res.ok) throw new Error("registrar unreachable");
        setCheck(await res.json());
      } catch {
        setCheck({ valid: false, reason: "could not reach the registrar" });
      }
    }, 350);
    return () => clearTimeout(t);
  }, [label]);

  useEffect(() => {
    if (phase !== "waiting" || countdown <= 0) return;
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [phase, countdown]);

  async function run(step: "commit" | "register") {
    setError(null);
    setPhase(step === "commit" ? "committing" : "registering");
    try {
      const res = await fetch("/api/ens/org", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // `owner` is the connected wallet: it must be byte-identical between commit and
        // register, because the commitment hash covers it.
        body: JSON.stringify({ step, label: label.trim().toLowerCase(), owner: address }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "failed");
      if (step === "commit") {
        setCountdown(body.readyInSeconds);
        setPhase("waiting");
      } else {
        onDone(body.name);
      }
    } catch (e) {
      setPhase("error");
      setError(e instanceof Error ? e.message : "failed");
    }
  }

  return (
    <Panel as="section">
      <div className="px-5 py-6">
        <h2 className="text-lg tracking-[-0.01em] text-ink">Claim the organization name</h2>
        <p className="mt-2 max-w-[54ch] text-sm leading-relaxed text-ink-muted">
          This name is the trust root. Every branch is registered beneath it and every membership
          resolves through it, so it is the one name that has to be bought.
        </p>

        <div className="mt-5 flex items-center gap-2">
          <input
            value={label}
            onChange={(e) => {
              setLabel(e.target.value.replace(/[^a-zA-Z0-9-]/g, "").toLowerCase());
              setCheck(null);
            }}
            placeholder="acme"
            aria-label="Organization name"
            autoComplete="off"
            className="h-12 min-w-0 flex-1 rounded-sharp border border-rule bg-paper px-3 font-mono text-base text-ink placeholder:text-ink-faint"
          />
          <span className="shrink-0 font-mono text-base text-ink-muted">.eth</span>
        </div>

        <div className="mt-2 min-h-[1.25rem]" role="status" aria-live="polite">
          {check && !check.valid ? (
            <p className="font-mono text-xs" style={{ color: "var(--alert)" }}>
              {check.reason}
            </p>
          ) : check?.available ? (
            <p className="font-mono text-xs text-ink-80">
              <span style={{ color: "var(--signal)" }}>available</span> · {check.priceFormatted} /
              year
            </p>
          ) : check ? (
            <p className="font-mono text-xs" style={{ color: "var(--alert)" }}>
              {check.name} is taken
            </p>
          ) : null}
        </div>

        {phase === "waiting" ? (
          <p className="mt-4 text-sm text-ink-muted">
            {countdown > 0
              ? `Waiting ${countdown}s. ENS enforces this delay so nobody watching the mempool can take the name first.`
              : "The commitment has matured — register it now."}
          </p>
        ) : null}

        {error ? (
          <p className="mt-4 text-xs leading-relaxed" style={{ color: "var(--alert)" }}>
            {error}
          </p>
        ) : null}

        <div className="mt-6 flex flex-wrap gap-2">
          {phase === "waiting" ? (
            <Button variant="solid" onClick={() => run("register")} disabled={countdown > 0}>
              {phase === "waiting" && countdown > 0 ? `Register in ${countdown}s` : "Register"}
            </Button>
          ) : (
            <Button
              variant="solid"
              onClick={() => run("commit")}
              disabled={
                !check?.available || phase === "committing" || !signer?.configured
              }
            >
              {phase === "committing" ? "Committing…" : "Claim this name"}
            </Button>
          )}
          <Button variant="ghost" onClick={() => onDone("")}>
            I already have one
          </Button>
        </div>

        {signer && !signer.configured ? (
          <p className="mt-4 text-xs text-ink-muted">
            Set <code className="font-mono">ORG_PRIVATE_KEY</code> to claim a name. Availability
            and pricing work without it.
          </p>
        ) : null}
      </div>
    </Panel>
  );
}

////////////////////////////////////////////////////////////////////////
// Step 2 — the first branch
////////////////////////////////////////////////////////////////////////

function BranchStep({
  onDone,
  onSkip,
}: {
  onDone: (label: string, registrar: string | null) => void;
  onSkip: () => void;
}) {
  const { address } = useAccount();
  const [label, setLabel] = useState("");
  const [free, setFree] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const value = label.trim().toLowerCase();
    if (!value) return;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/ens/branch?label=${value}`);
        // A 502 is the chain not answering, not a label being taken. Rendering it as "exists"
        // would stop an operator opening a branch for the length of an RPC blip.
        if (!res.ok) return setFree(null);
        const body = await res.json();
        setFree(body.valid ? body.available : false);
      } catch {
        setFree(null);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [label]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/ens/branch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // The connected wallet takes root of the new branch registry, not the server key.
        body: JSON.stringify({ label: label.trim().toLowerCase(), owner: address }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "failed");
      onDone(body.label, body.registrar ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel as="section">
      <div className="px-5 py-6">
        <h2 className="text-lg tracking-[-0.01em] text-ink">Open the first branch</h2>
        <p className="mt-2 max-w-[54ch] text-sm leading-relaxed text-ink-muted">
          A branch is a location — an event, an office, a site. It gets a registry of its own, so
          memberships live inside it rather than at the organization level.
        </p>

        <div className="mt-5 flex items-center gap-2">
          <input
            value={label}
            onChange={(e) => {
              setLabel(e.target.value.replace(/[^a-zA-Z0-9-]/g, "").toLowerCase());
              setFree(null);
            }}
            placeholder="tokyo"
            aria-label="Branch name"
            autoComplete="off"
            className="h-12 min-w-0 flex-1 rounded-sharp border border-rule bg-paper px-3 font-mono text-base text-ink placeholder:text-ink-faint"
          />
        </div>

        <div className="mt-2 min-h-[1.25rem]" role="status">
          {free === true ? (
            <p className="font-mono text-xs" style={{ color: "var(--signal)" }}>
              available
            </p>
          ) : free === false ? (
            <p className="font-mono text-xs" style={{ color: "var(--alert)" }}>
              that branch already exists
            </p>
          ) : null}
        </div>

        <p className="mt-4 text-xs leading-relaxed text-ink-muted">
          One transaction deploys the branch&rsquo;s registry and registrar, links them to the
          organization in both directions, grants the registrar its authority, and publishes it so
          the branch is discoverable from ENS alone.
        </p>

        {error ? (
          <p className="mt-4 text-xs leading-relaxed" style={{ color: "var(--alert)" }}>
            {error}
          </p>
        ) : null}

        <div className="mt-6 flex flex-wrap gap-2">
          <Button variant="solid" onClick={create} disabled={!free || busy}>
            {busy ? "Opening…" : "Open branch"}
          </Button>
          <Button variant="ghost" onClick={onSkip}>
            Skip
          </Button>
        </div>
      </div>
    </Panel>
  );
}

////////////////////////////////////////////////////////////////////////
// Step 3 — groups
////////////////////////////////////////////////////////////////////////

const PRESETS = [
  { name: "hacker", rate: "5mbps", ceil: "20mbps", group: "hacker", onboard: false },
  { name: "volunteer", rate: "10mbps", ceil: "50mbps", group: "staff", onboard: true },
  { name: "mentor", rate: "20mbps", ceil: "100mbps", group: "mentor", onboard: false },
];

function GroupsStep({
  registrar,
  onDone,
}: {
  registrar: string | null;
  onDone: () => void;
}) {
  const [branches, setBranches] = useState<{ label: string; registrar: string | null }[]>([]);
  const [target, setTarget] = useState(registrar ?? "");
  const [created, setCreated] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/ens/branches")
      .then((r) => r.json())
      .then((d) => {
        const withReg = (d.branches ?? []).filter(
          (b: { registrar: string | null }) => b.registrar,
        );
        setBranches(withReg);
        if (!target && withReg[0]) setTarget(withReg[0].registrar);
      })
      .catch(() => undefined);
  }, [target]);

  async function add(preset: (typeof PRESETS)[number]) {
    setBusy(preset.name);
    setError(null);
    try {
      const res = await fetch("/api/ens/groups", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          registrar: target,
          name: preset.name,
          canOnboard: preset.onboard,
          openToOnboarders: !preset.onboard,
          editableKeys: [],
          entitlements: [
            { key: "role", value: preset.name },
            { key: "wifi.group", value: preset.group },
            { key: "wifi.rate", value: preset.rate },
            { key: "wifi.ceil", value: preset.ceil },
          ],
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "failed");
      setCreated((c) => [...c, preset.name]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Panel as="section">
      <div className="px-5 py-6">
        <h2 className="text-lg tracking-[-0.01em] text-ink">Define the groups</h2>
        <p className="mt-2 max-w-[54ch] text-sm leading-relaxed text-ink-muted">
          A group is a category of people — it mints no name. Onboarding assigns one, and its
          entitlements are written onto that person&rsquo;s name in the same transaction.
        </p>

        {branches.length > 1 ? (
          <label className="mt-5 block">
            <span className="label">Branch</span>
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className="mt-2 h-11 w-full rounded-sharp border border-rule bg-paper px-2 font-mono text-xs text-ink"
            >
              {branches.map((b) => (
                <option key={b.label} value={b.registrar ?? ""}>
                  {b.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <ul className="mt-5 divide-y divide-rule border-y border-rule">
          {PRESETS.map((p) => (
            <li key={p.name} className="flex items-center justify-between gap-4 py-3">
              <span className="min-w-0">
                <span className="block font-mono text-sm text-ink">{p.name}</span>
                <span className="mt-0.5 block font-mono text-[0.6875rem] text-ink-muted">
                  {p.rate} / {p.ceil} · group {p.group}
                  {p.onboard ? " · may onboard" : ""}
                </span>
              </span>
              <Button
                variant={created.includes(p.name) ? "ghost" : "outline"}
                onClick={() => add(p)}
                disabled={!target || busy !== null || created.includes(p.name)}
              >
                {created.includes(p.name)
                  ? "added"
                  : busy === p.name
                    ? "adding…"
                    : "add"}
              </Button>
            </li>
          ))}
        </ul>

        <p className="mt-3 text-xs text-ink-muted">
          These are starting points. Groups are data — you can add your own, with any name, from
          the console.
        </p>

        {error ? (
          <p className="mt-4 text-xs leading-relaxed" style={{ color: "var(--alert)" }}>
            {error}
          </p>
        ) : null}

        <div className="mt-6">
          <Button variant="solid" onClick={onDone}>
            Done
          </Button>
        </div>
      </div>
    </Panel>
  );
}

////////////////////////////////////////////////////////////////////////
// Step 4
////////////////////////////////////////////////////////////////////////

function DoneStep({ org, branch }: { org: string | null; branch: string | null }) {
  return (
    <Panel as="section" className="overflow-hidden">
      <div className="relative h-28 border-b border-rule">
        <SignalDither motif="ripple" cell={3} period={3.4} intensity={0.6} className="absolute inset-0" />
      </div>
      <div className="px-5 py-6">
        <h2 className="text-lg tracking-[-0.01em] text-ink">The organization is open</h2>
        <p className="mt-2 max-w-[54ch] text-sm leading-relaxed text-ink-muted">
          {branch
            ? `Onboard someone into ${branch} and their name, role and entitlements are written in one transaction — then the network admits them.`
            : "Open a branch and onboard someone, and their name, role and entitlements are written in one transaction."}
        </p>
        <div className="mt-6 flex flex-wrap gap-2">
          <ButtonLink href="/console/members" variant="solid">
            Onboard someone
          </ButtonLink>
          <ButtonLink href="/console">Open the console</ButtonLink>
        </div>
        {org ? (
          <p className="mt-4 font-mono text-xs text-ink-muted">
            <Link href="/console" className="underline decoration-rule underline-offset-2">
              {org}
            </Link>
          </p>
        ) : null}
      </div>
    </Panel>
  );
}
