"use client";

import { useEffect, useState } from "react";
import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { ensAppLink, useOrgName, useOwnedNames } from "@/lib/ens/useOrgName";
import { withOrg } from "@/lib/hooks/useOrg";
import { useOrgSetup, type OrgAddresses } from "@/lib/ens/useOrgSetup";
import { useEnsWrites } from "@/lib/ens/useEnsWrites";
import type { Address } from "viem";
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

type StepId = "connect" | "name" | "setup" | "branch" | "groups" | "done";

const STEPS: { id: StepId; title: string; blurb: string }[] = [
  { id: "connect", title: "Wallet", blurb: "Connect the wallet that will own the organization." },
  { id: "name", title: "Name", blurb: "The .eth name the organization is built on." },
  { id: "setup", title: "Set up", blurb: "Deploy the contracts that live under that name." },
  { id: "branch", title: "Branch", blurb: "Open a location. It gets its own registry." },
  { id: "groups", title: "Groups", blurb: "Define the categories people are onboarded into." },
  { id: "done", title: "Open", blurb: "Start admitting people." },
];

export function Wizard() {
  const [step, setStep] = useState<StepId>("connect");
  const [orgName, setOrgName] = useState<string | null>(null);
  const [branchLabel, setBranchLabel] = useState<string | null>(null);
  const [registrar, setRegistrar] = useState<string | null>(null);
  const [org, setOrg] = useState<OrgAddresses | null>(null);

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
              setStep("setup");
            }}
          />
        ) : null}

        {step === "setup" && orgName ? (
          <SetupStep
            orgName={orgName}
            onDone={(addresses) => {
              setOrg(addresses);
              setStep("branch");
            }}
          />
        ) : null}

        {step === "branch" ? (
          <BranchStep
            org={orgName}
            factory={(org?.branchFactory ?? null) as `0x${string}` | null}
            onDone={(label, reg) => {
              setBranchLabel(label);
              setRegistrar(reg);
              setStep("groups");
            }}
            onSkip={() => setStep("groups")}
          />
        ) : null}

        {step === "groups" ? (
          <GroupsStep
            branchLabel={branchLabel}
            registrar={registrar}
            onDone={() => setStep("done")}
          />
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
  const { status, recheck } = useOrgName(label);
  const owned = useOwnedNames();

  // Only a two-label `.eth` name can be an organization root. A subname is already somebody's
  // branch or membership, and building a second organization inside it would be a different
  // product to the one this wizard describes.
  const roots = (owned.names ?? []).filter((n) => n.isTopLevel);

  return (
    <Panel as="section">
      <div className="px-5 py-6">
        <h2 className="text-lg tracking-[-0.01em] text-ink">Choose the organization name</h2>
        <p className="mt-2 max-w-[56ch] text-sm leading-relaxed text-ink-muted">
          This name is the trust root. Every branch is registered beneath it and every membership
          resolves through it, so it has to be a name you own. Search for one here; if it is free,
          the ENS app registers it — that is its job, and it does the commit-and-reveal dance
          properly.
        </p>

        {address ? (
          <div className="mt-5">
            <span className="label">Names this wallet holds</span>
            {owned.loading && owned.names === null ? (
              <p className="mt-2 font-mono text-xs text-ink-muted">reading…</p>
            ) : owned.error ? (
              <p className="mt-2 text-xs leading-relaxed text-ink-muted">
                Could not list them — {owned.error}. Search for the name below instead; that
                reads the registry directly.
              </p>
            ) : roots.length === 0 ? (
              <p className="mt-2 text-xs leading-relaxed text-ink-muted">
                None yet. Search below, then register one on the ENS app.
              </p>
            ) : (
              <ul className="mt-2 divide-y divide-rule rounded-sharp border border-rule">
                {roots.map((n) => (
                  <li key={n.name} className="flex items-center justify-between gap-3 px-3 py-2.5">
                    <span className="min-w-0">
                      <span className="block truncate font-mono text-sm text-ink">{n.name}</span>
                      {n.expiry ? (
                        <span className="block font-mono text-[0.6875rem] text-ink-muted">
                          expires {new Date(n.expiry * 1000).toLocaleDateString()}
                        </span>
                      ) : null}
                    </span>
                    <Button variant="outline" onClick={() => onDone(n.name)}>
                      Use this
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}

        <div className="mt-6">
          <span className="label">{address ? "Or search for another" : "Search for a name"}</span>
        </div>

        <div className="mt-2 flex items-center gap-2">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value.replace(/[^a-zA-Z0-9-]/g, "").toLowerCase())}
            placeholder="search for a name"
            aria-label="Organization name"
            autoComplete="off"
            className="h-12 min-w-0 flex-1 rounded-sharp border border-rule bg-paper px-3 font-mono text-base text-ink placeholder:text-ink-faint"
          />
          <span className="shrink-0 font-mono text-base text-ink-muted">.eth</span>
        </div>

        <div className="mt-4" role="status" aria-live="polite">
          {status.state === "idle" ? (
            <p className="text-xs text-ink-muted">
              Type a name to see whether it is free — or whether this wallet already holds it.
            </p>
          ) : status.state === "checking" ? (
            <p className="font-mono text-xs text-ink-muted">checking…</p>
          ) : status.state === "invalid" ? (
            <p className="font-mono text-xs" style={{ color: "var(--alert)" }}>
              {status.reason}
            </p>
          ) : status.state === "yours" ? (
            <div className="rounded-sharp border border-rule px-4 py-3">
              <p className="text-sm text-ink">
                <span className="font-mono">{status.name}</span> is yours.
              </p>
              <p className="mt-1 text-xs leading-relaxed text-ink-muted">
                This wallet owns it, so you can build the organization on it.
              </p>
              <div className="mt-3">
                <Button variant="solid" onClick={() => onDone(status.name)}>
                  Use {status.name}
                </Button>
              </div>
            </div>
          ) : status.state === "available" ? (
            <div className="rounded-sharp border border-rule px-4 py-3">
              <p className="text-sm text-ink">
                <span className="font-mono">{status.name}</span> is available
                {status.priceFormatted ? ` · ${status.priceFormatted} / year` : ""}.
              </p>
              <p className="mt-1 max-w-[52ch] text-xs leading-relaxed text-ink-muted">
                Register it on the ENS app, then come back. Registration takes two transactions
                and a short wait, which is worth doing in the tool built for it rather than a
                second implementation here.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <ButtonLink href={ensAppLink(status.name)} target="_blank" rel="noreferrer">
                  Register on the ENS app ↗
                </ButtonLink>
                <button
                  type="button"
                  onClick={() => {
                    void recheck();
                    void owned.reload();
                  }}
                  className="font-mono text-xs text-ink-muted underline decoration-rule underline-offset-2 hover:text-ink"
                >
                  I have registered it
                </button>
              </div>
            </div>
          ) : (
            <div className="rounded-sharp border border-rule px-4 py-3">
              <p className="text-sm text-ink">
                <span className="font-mono">{status.name}</span> is already registered
                {address ? ", and not to this wallet" : ""}.
              </p>
              <p className="mt-1 font-mono text-[0.6875rem] text-ink-muted">
                owner {status.owner.slice(0, 6)}…{status.owner.slice(-4)}
              </p>
              {!address ? (
                <p className="mt-1 text-xs text-ink-muted">
                  Connect the wallet that holds it and this will say so.
                </p>
              ) : null}
              <div className="mt-3">
                <ButtonLink href={ensAppLink(status.name)} target="_blank" rel="noreferrer">
                  View it on the ENS app ↗
                </ButtonLink>
              </div>
            </div>
          )}
        </div>
      </div>
    </Panel>
  );
}

////////////////////////////////////////////////////////////////////////
// Step 2 — the organization's own contracts
////////////////////////////////////////////////////////////////////////

/**
 * Owning the name is not the same as having an organization.
 *
 * An organization is a registry to hold branches, a resolver to publish records, an OrgRegistrar
 * for the Member layer and a BranchFactory to open branches — all pinned to this one name. Until
 * this step existed, choosing a name changed a label on screen and nothing underneath: branches
 * still landed under whichever organization the deploy scripts had been aimed at.
 */
function SetupStep({ orgName, onDone }: { orgName: string; onDone: (org: OrgAddresses) => void }) {
  const label = orgName.replace(/\.eth$/, "");
  const setup = useOrgSetup(label);

  const ready = setup.state.step === "deployed" && setup.state.pointed;

  return (
    <Panel as="section">
      <div className="px-5 py-6">
        <h2 className="text-lg tracking-[-0.01em] text-ink">
          Set <span className="font-mono">{orgName}</span> up as an organization
        </h2>
        <p className="mt-2 max-w-[56ch] text-sm leading-relaxed text-ink-muted">
          This deploys the contracts that live under your name — a registry for branches, a
          resolver for records, and the registrars that mint memberships. They are yours: this
          console keeps no key and no role over any of them.
        </p>

        <p className="mt-2 font-mono text-[0.6875rem] text-ink-muted">
          {setup.batchable
            ? "your wallet can batch these — one confirmation"
            : "your wallet signs these one at a time"}
        </p>

        <ol className="mt-5 space-y-4">
          <li className="rounded-sharp border border-rule px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-sm text-ink">
                1 · Deploy the contracts and point {orgName} at them
              </span>
              {ready ? (
                <span className="font-mono text-xs" style={{ color: "var(--signal)" }}>
                  done
                </span>
              ) : (
                <Button variant="solid" onClick={setup.create} disabled={setup.busy}>
                  {setup.busy ? "Deploying…" : "Deploy"}
                </Button>
              )}
            </div>
            {setup.state.step === "deployed" ? (
              <dl className="mt-3 space-y-1">
                {(
                  [
                    ["registry", setup.state.org.registry],
                    ["resolver", setup.state.org.resolver],
                    ["member registrar", setup.state.org.orgRegistrar],
                    ["branch factory", setup.state.org.branchFactory],
                  ] as const
                ).map(([term, value]) => (
                  <div key={term} className="flex items-baseline justify-between gap-3">
                    <dt className="font-mono text-[0.6875rem] text-ink-muted">{term}</dt>
                    <dd className="font-mono text-[0.6875rem] text-ink-80">
                      {value.slice(0, 10)}…{value.slice(-6)}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </li>

          {/* Only shown when the first step did not manage the pointing — an interrupted
              sequential run, or a wallet that refused the delegation. */}
          {setup.state.step === "deployed" && !setup.state.pointed ? (
            <li className="rounded-sharp border border-rule px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-sm text-ink">2 · Point {orgName} at them</span>
                <Button variant="solid" onClick={setup.point} disabled={setup.busy}>
                  {setup.busy ? "Pointing…" : "Point the name"}
                </Button>
              </div>
              <p className="mt-2 max-w-[52ch] text-xs leading-relaxed text-ink-muted">
                The contracts exist but the name does not resolve to them yet. Only the
                name&rsquo;s owner can change that, so it is a transaction from this wallet.
              </p>
            </li>
          ) : null}
        </ol>

        {setup.error ? (
          <p className="mt-3 text-xs leading-relaxed" style={{ color: "var(--alert)" }} role="status">
            {setup.error}
          </p>
        ) : null}

        <div className="mt-5">
          <Button
            variant="solid"
            onClick={() => setup.state.step === "deployed" && onDone(setup.state.org)}
            disabled={!ready}
          >
            Continue
          </Button>
        </div>
      </div>
    </Panel>
  );
}

////////////////////////////////////////////////////////////////////////
// Step 3 — the first branch
////////////////////////////////////////////////////////////////////////

function BranchStep({
  org,
  factory,
  onDone,
  onSkip,
}: {
  /** The organization's `.eth` name — the availability check is scoped to it. */
  org: string | null;
  factory: `0x${string}` | null;
  onDone: (label: string, registrar: string | null) => void;
  onSkip: () => void;
}) {
  const { address } = useAccount();
  const writes = useEnsWrites();
  const [label, setLabel] = useState("");
  const [free, setFree] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkFailed, setCheckFailed] = useState(false);

  const orgLabel = org?.replace(/\.eth$/, "") ?? "";

  useEffect(() => {
    const value = label.trim().toLowerCase();
    if (!value || !orgLabel) return;
    const t = setTimeout(async () => {
      try {
        // Scoped to the organization. Without `org` this route answers 400, which read here as
        // "could not check" and left the button disabled for good — the label was never once
        // reported free, so the form could not be submitted at all.
        const res = await fetch(
          `/api/ens/branch?label=${encodeURIComponent(value)}&org=${encodeURIComponent(orgLabel)}`,
        );
        // A 502 is the chain not answering, not a label being taken. Rendering it as "exists"
        // would stop an operator opening a branch for the length of an RPC blip.
        if (!res.ok) {
          setFree(null);
          setCheckFailed(true);
          return;
        }
        const body = await res.json();
        setCheckFailed(false);
        setFree(body.valid ? body.available : false);
      } catch {
        setFree(null);
        setCheckFailed(true);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [label, orgLabel]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      // Signed by the connected wallet, which must hold ROLE_CREATE_BRANCH on the factory —
      // the organization's own check, not ours — and which takes root of the new registry.
      const created = await writes.createBranch(
        label.trim().toLowerCase(),
        BigInt(Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60),
        address as Address,
        factory as `0x${string}`,
      );
      if (!created) throw new Error(writes.error ?? "the transaction did not go through");
      const body = created;
      onDone(body.label, body.registrar);
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
              setCheckFailed(false);
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
          ) : checkFailed ? (
            <p className="font-mono text-xs text-ink-muted">
              could not check — the chain did not answer. You can still try; the registry decides.
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
          <Button
            variant="solid"
            onClick={create}
            disabled={busy || !label.trim() || free === false || !factory}
          >
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

/**
 * Starting points, not policy.
 *
 * These are prefilled into the editor rather than written straight to chain, because the
 * numbers in them are invented. A rate of `5mbps` means whatever the branch enforcer decides it
 * means; publishing it because a wizard suggested it would put a figure on chain that nobody
 * chose and nothing enforces.
 */
const PRESETS = [
  {
    name: "hacker",
    onboard: false,
    keys: "",
    entitlements: [
      { key: "wifi.group", value: "hacker" },
      { key: "wifi.rate", value: "5mbps" },
      { key: "wifi.ceil", value: "20mbps" },
    ],
  },
  {
    name: "volunteer",
    onboard: true,
    keys: "",
    entitlements: [
      { key: "wifi.group", value: "staff" },
      { key: "wifi.rate", value: "10mbps" },
      { key: "wifi.ceil", value: "50mbps" },
    ],
  },
  {
    name: "mentor",
    onboard: false,
    keys: "avatar, ssh.pubkey",
    entitlements: [
      { key: "wifi.group", value: "mentor" },
      { key: "wifi.rate", value: "20mbps" },
      { key: "wifi.ceil", value: "100mbps" },
    ],
  },
];

type Row = { key: string; value: string };

function GroupsStep({
  branchLabel,
  registrar,
  onDone,
}: {
  branchLabel: string | null;
  registrar: string | null;
  onDone: () => void;
}) {
  // The branch you just opened, carried here from its own receipt.
  //
  // This used to fetch every branch in the *configured* organization and offer them in a
  // dropdown — so after creating a branch under your own name you were shown somebody else's
  // list and could not find it. There is nothing to choose: the previous step already returned
  // the registrar, which is why it decodes `BranchCreated` rather than waiting for an indexer.
  const target = registrar ?? "";
  const writes = useEnsWrites();
  const [created, setCreated] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [canOnboard, setCanOnboard] = useState(false);
  const [editableKeys, setEditableKeys] = useState("");
  const [rows, setRows] = useState<Row[]>([{ key: "wifi.group", value: "" }]);

  function prefill(preset: (typeof PRESETS)[number]) {
    setName(preset.name);
    setCanOnboard(preset.onboard);
    setEditableKeys(preset.keys);
    setRows(preset.entitlements.map((e) => ({ ...e })));
    setError(null);
  }

  function reset() {
    setName("");
    setCanOnboard(false);
    setEditableKeys("");
    setRows([{ key: "wifi.group", value: "" }]);
  }

  const clean = name.trim().toLowerCase();
  const valid = /^[a-z0-9-]{1,32}$/.test(clean) && !created.includes(clean) && Boolean(target);

  async function add() {
    setBusy(true);
    setError(null);
    try {
      const written = await writes.defineGroup({
        registrar: target as Address,
        name: clean,
        canOnboard,
        openToOnboarders: true,
        editableKeys: editableKeys
          .split(",")
          .map((k) => k.trim())
          .filter(Boolean),
        entitlements: rows.filter((r) => r.key.trim() && r.value.trim()),
      });
      if (!written) throw new Error(writes.error ?? "the transaction did not go through");

      await fetch("/api/ens/mirror", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "group", registrar: target, name: clean }),
      });
      setCreated((c) => [...c, clean]);
      reset();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel as="section">
      <div className="px-5 py-6">
        <h2 className="text-lg tracking-[-0.01em] text-ink">Define the groups</h2>
        <p className="mt-2 max-w-[54ch] text-sm leading-relaxed text-ink-muted">
          A group is a category of people — it mints no name. Onboarding assigns one, and its
          entitlements are written onto that person&rsquo;s name in the same transaction. Name
          them whatever your organization actually calls people.
        </p>

        {target ? (
          <div className="mt-5 rounded-sharp border border-rule px-4 py-3">
            <span className="label">Branch</span>
            <p className="mt-1 font-mono text-sm text-ink">{branchLabel ?? "—"}</p>
            <p className="mt-1 font-mono text-[0.6875rem] text-ink-muted">
              registrar {target.slice(0, 10)}…{target.slice(-6)}
            </p>
          </div>
        ) : (
          <div className="mt-5 rounded-sharp border border-rule px-4 py-3">
            <p className="text-sm" style={{ color: "var(--alert)" }}>
              No branch to define groups on.
            </p>
            <p className="mt-1 max-w-[52ch] text-xs leading-relaxed text-ink-muted">
              Go back and open one — groups belong to a branch, so there is nowhere to put these
              until one exists.
            </p>
          </div>
        )}

        {created.length > 0 ? (
          <ul className="mt-5 divide-y divide-rule border-y border-rule">
            {created.map((g) => (
              <li key={g} className="flex items-center justify-between gap-4 py-2.5">
                <span className="font-mono text-sm text-ink">{g}</span>
                <span className="font-mono text-xs" style={{ color: "var(--signal)" }}>
                  defined
                </span>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="mt-6">
          <span className="label">Start from</span>
          <div className="mt-2 flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <Button key={p.name} variant="outline" onClick={() => prefill(p)}>
                {p.name}
              </Button>
            ))}
            <Button variant="ghost" onClick={reset}>
              blank
            </Button>
          </div>
          <p className="mt-2 max-w-[52ch] text-xs leading-relaxed text-ink-muted">
            These fill the form below so you can see and change what gets published. The rates
            are suggestions — what they mean is the branch enforcer&rsquo;s decision, not ENS&rsquo;s.
          </p>
        </div>

        <div className="mt-5 space-y-4 rounded-sharp border border-rule px-4 py-4">
          <label className="block">
            <span className="label">Group name</span>
            <input
              value={name}
              onChange={(e) =>
                setName(e.target.value.replace(/[^a-zA-Z0-9-]/g, "").toLowerCase())
              }
              placeholder="crew"
              autoComplete="off"
              className="mt-2 h-11 w-full rounded-sharp border border-rule bg-paper px-3 font-mono text-sm text-ink placeholder:text-ink-faint"
            />
          </label>

          <label className="flex items-start gap-2.5">
            <input
              type="checkbox"
              checked={canOnboard}
              onChange={(e) => setCanOnboard(e.target.checked)}
              className="mt-0.5 size-4 shrink-0 accent-[var(--ink)]"
            />
            <span className="min-w-0">
              <span className="block text-sm text-ink">Members of this group may onboard others</span>
              <span className="block text-xs leading-relaxed text-ink-muted">
                Authority is derived from the membership, so there is no per-person grant and no
                limit on how many of them there are.
              </span>
            </span>
          </label>

          <label className="block">
            <span className="label">Self-editable records</span>
            <input
              value={editableKeys}
              onChange={(e) => setEditableKeys(e.target.value)}
              placeholder="avatar, ssh.pubkey"
              autoComplete="off"
              className="mt-2 h-11 w-full rounded-sharp border border-rule bg-paper px-3 font-mono text-xs text-ink placeholder:text-ink-faint"
            />
            <span className="mt-1 block text-xs leading-relaxed text-ink-muted">
              Comma-separated keys a member may write on their own name — and only their own.
              Leave empty and they can write nothing.
            </span>
          </label>

          <fieldset>
            <legend className="label">Entitlements written to every member</legend>
            <div className="mt-2 space-y-2">
              {rows.map((row, i) => (
                <div key={i} className="flex gap-2">
                  <input
                    value={row.key}
                    onChange={(e) =>
                      setRows(rows.map((r, j) => (i === j ? { ...r, key: e.target.value } : r)))
                    }
                    placeholder="key"
                    aria-label={`Entitlement key ${i + 1}`}
                    className="h-10 w-2/5 rounded-sharp border border-rule bg-paper px-2 font-mono text-xs text-ink placeholder:text-ink-faint"
                  />
                  <input
                    value={row.value}
                    onChange={(e) =>
                      setRows(rows.map((r, j) => (i === j ? { ...r, value: e.target.value } : r)))
                    }
                    placeholder="value"
                    aria-label={`Entitlement value ${i + 1}`}
                    className="h-10 min-w-0 flex-1 rounded-sharp border border-rule bg-paper px-2 font-mono text-xs text-ink placeholder:text-ink-faint"
                  />
                  {rows.length > 1 ? (
                    <button
                      type="button"
                      onClick={() => setRows(rows.filter((_, j) => j !== i))}
                      aria-label={`Remove entitlement ${i + 1}`}
                      className="shrink-0 px-2 font-mono text-xs text-ink-muted hover:text-ink"
                    >
                      ×
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setRows([...rows, { key: "", value: "" }])}
              className="mt-2 font-mono text-[0.6875rem] text-ink-muted underline decoration-rule underline-offset-2 hover:text-ink"
            >
              add another
            </button>
            <p className="mt-2 max-w-[52ch] text-xs leading-relaxed text-ink-muted">
              <span className="font-mono">wifi.group</span> is the one the enforcer joins on — it
              decides what that group is worth locally. Everything else is yours to invent.
            </p>
          </fieldset>

          {error ? (
            <p className="text-xs leading-relaxed" style={{ color: "var(--alert)" }} role="status">
              {error}
            </p>
          ) : null}

          <Button variant="solid" onClick={add} disabled={!valid || busy}>
            {busy ? "Defining…" : "Define this group"}
          </Button>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Button variant="solid" onClick={onDone} disabled={created.length === 0}>
            Done
          </Button>
          {created.length === 0 ? (
            <span className="text-xs text-ink-muted">
              Define at least one — a branch with no groups can admit nobody.
            </span>
          ) : null}
        </div>
      </div>
    </Panel>
  );
}

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
          <ButtonLink href={withOrg("/console/people", org?.replace(/\.eth$/, "") ?? null)} variant="solid">
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
