"use client";

import Image from "next/image";
import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { SignalDither } from "@/components/dither/SignalDither";
import { WifiMark } from "@/components/WifiMark";
import { ArrowRightIcon } from "@/components/ui/icons";

/* ── Slides ────────────────────────────────────────────────────────────────
   Five, in the order a judge needs them: what it is, why it matters, how it
   works, what ENS does in it, and proof that it runs. Copy is drawn from
   submission.md and docs/13, docs/15 — keep them in step.
   ────────────────────────────────────────────────────────────────────── */

function Kicker({ n, children }: { n: number; children: ReactNode }) {
  return (
    <p className="label flex items-center gap-3">
      <span className="text-ink">{String(n).padStart(2, "0")}</span>
      <span aria-hidden className="h-px w-8 bg-rule" />
      {children}
    </p>
  );
}

function Heading({ children }: { children: ReactNode }) {
  return (
    <h2 className="mt-5 max-w-[22ch] text-balance font-mono text-3xl font-medium leading-[1.02] tracking-[-0.03em] text-ink sm:text-4xl lg:text-5xl">
      {children}
    </h2>
  );
}

function Plate({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-sharp border border-rule bg-paper-raise ${className}`}>{children}</div>
  );
}

function Code({ children }: { children: ReactNode }) {
  return <code className="font-mono text-[0.8125rem] text-ink">{children}</code>;
}

function TitleSlide() {
  return (
    <div className="grid h-full items-center gap-10 lg:grid-cols-[1fr_1fr]">
      <div>
        <h1 className="font-mono text-6xl font-medium leading-[0.9] tracking-[-0.04em] sm:text-7xl lg:text-8xl">
          Radius
        </h1>
        <p className="mt-7 max-w-[20ch] text-balance text-2xl leading-[1.15] tracking-[-0.01em] sm:text-3xl lg:text-4xl">
          Your ENS subname is the credential.
        </p>
        <p className="mt-5 max-w-[50ch] leading-relaxed text-ink-muted">
          Identity-gated WiFi, bandwidth, API keys and SSH for any organization that owns an ENS
          name. Mint a subname, walk in, connect. No password, no RADIUS server, no user database
          on the box.
        </p>
        <p className="mt-8 font-mono text-sm text-ink">
          leo<span className="text-ink-muted">.tokyo.</span>ethglobal
          <span className="text-ink-muted">.eth</span>
          <span className="ml-3 label">→ admitted · mentor · 20 Mbit</span>
        </p>
      </div>
      <div className="relative min-h-[260px] self-stretch sm:min-h-[340px]">
        <SignalDither
          motif="wifi"
          cell={4}
          className="absolute inset-0"
          label="Wifi signal, rendered as an animated ordered dither"
        />
      </div>
    </div>
  );
}

function Shot({
  src,
  width,
  height,
  alt,
  aspect = "aspect-[16/9]",
}: {
  src: string;
  width: number;
  height: number;
  alt: string;
  /** Not every piece of evidence is widescreen; a square photo cover-cropped to 16/9 loses its subject. */
  aspect?: string;
}) {
  return (
    <div className={`${aspect} overflow-hidden rounded-sharp border border-rule bg-ink`}>
      <Image
        src={src}
        width={width}
        height={height}
        alt={alt}
        sizes="(min-width: 1024px) 420px, 50vw"
        className="h-full w-full object-cover"
      />
    </div>
  );
}

function ProblemSlide() {
  return (
    <div className="grid items-center gap-10 lg:grid-cols-[0.7fr_1.3fr] lg:gap-10">
      <div>
        <Kicker n={2}>The problem</Kicker>
        <h2 className="mt-6 text-balance font-mono text-3xl font-medium leading-[1.05] tracking-[-0.03em] sm:text-4xl">
          We all know what happened at ETHGlobal New Delhi.
        </h2>
        <p className="mt-6 text-balance text-2xl leading-snug sm:text-3xl">
          We couldn&rsquo;t use the WiFi for hours.
        </p>
        <p className="mt-6 max-w-[48ch] leading-relaxed text-ink-muted">
          The venue network slowed down, so everyone switched on a hotspot. Dozens of hotspots on
          the same channels drowned the venue WiFi completely. It took the stage asking people to
          turn them off to get it back.
        </p>
      </div>

      {/* The sketch's zig-zag, without the overlap: two stacked on the left, the stage shot
          centred on the right so the speaker is never covered. */}
      <div className="grid grid-cols-2 items-center gap-3">
        <div className="flex flex-col gap-3">
          <Shot
            src="/pitch/delhi-no-hotspots.webp"
            width={1600}
            height={903}
            alt="Stage slide at ETHGlobal New Delhi reading: Do not use mobile hotspots."
          />
          <Shot
            src="/pitch/delhi-spectrum-chart.webp"
            width={1000}
            height={563}
            alt="5 GHz spectrum chart: the ETHGlobal network on channel 149 buried under hotspot signals of equal strength, with only channel 165 open."
          />
        </div>
        <Shot
          src="/pitch/delhi-hotspot-stage.webp"
          width={1600}
          height={898}
          alt="On stage at ETHGlobal New Delhi: the speaker beside a WiFi scan listing dozens of personal hotspots broadcasting in the venue."
        />
      </div>
    </div>
  );
}

const STEPS = [
  ["Mint", "Check-in mints a subname under the perimeter. Its role writes wifi.group, wifi.rate, wifi.ceil as text records."],
  ["Sign", "Device joins WiFi, hits the captive portal, signs an EIP-191 challenge. The signer resolves to a membership."],
  ["Enforce", "iptables fwmark + tc HTB class per role, in the kernel. Cross-group FORWARD DROP isolates tiers."],
  ["Proxy", "API calls go through /proxy/<slug>. Keys are injected server-side; per-person and per-group daily quotas."],
  ["Audit", "Every admission and request logs against a session, not an IP. Revoke one name, not the whole network."],
] as const;

function HowSlide() {
  return (
    <div>
      <Kicker n={5}>How it works</Kicker>
      <Heading>Mint a name. Walk in. Connect.</Heading>
      <ol className="mt-10 grid gap-3 md:grid-cols-5">
        {STEPS.map(([title, body], i) => (
          <li key={title} className="relative">
            <Plate className="h-full p-4">
              <p className="label">Step {i + 1}</p>
              <p className="mt-3 font-mono text-lg font-medium">{title}</p>
              <p className="mt-2 text-sm leading-relaxed text-ink-muted">{body}</p>
            </Plate>
          </li>
        ))}
      </ol>
      <div className="mt-8 grid gap-3 text-sm sm:grid-cols-3">
        {[
          ["Captive portal", "Flask, root — iptables + tc grant/revoke"],
          ["Resource proxy", "Flask, unprivileged — keys, quotas, audit, rotation"],
          ["Console", "Next.js + viem — orgs, perimeters, roles on ENS"],
        ].map(([t, d]) => (
          <div key={t} className="border-t border-rule pt-3">
            <p className="font-mono font-medium">{t}</p>
            <p className="mt-1 text-ink-muted">{d}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

const TREE: [depth: number, name: string, kind: string][] = [
  [0, "ethglobal.eth", "Organization · org registry"],
  [1, "tokyo.ethglobal.eth", "Perimeter · own subregistry, expiry = event window"],
  [2, "leo.tokyo.ethglobal.eth", "Membership · mentor"],
  [2, "ann.tokyo.ethglobal.eth", "Membership · hacker"],
  [1, "leo.ethglobal.eth", "Member · org-wide role, survives events"],
];

const RECORDS = [
  ["wifi.group", "VLAN / isolation group the device lands in"],
  ["wifi.rate · wifi.ceil", "Guaranteed and burst bandwidth → tc HTB class"],
  ["ssh.pubkey", "Shell access via AuthorizedKeysCommand"],
  ["ensca.registrar", "Where a perimeter's registrar lives — org tree is discoverable"],
] as const;

function EnsSlide() {
  return (
    <div>
      <Kicker n={6}>The role of ENS</Kicker>
      <Heading>ENS isn&rsquo;t a feature here. It is the access-control plane.</Heading>

      <div className="mt-8 grid gap-4 lg:grid-cols-[1.05fr_1fr]">
        <Plate className="p-5">
          <p className="label">Names are the org chart</p>
          <ul className="mt-4 space-y-2.5">
            {TREE.map(([depth, name, kind]) => (
              <li key={name} style={{ paddingLeft: `${depth * 1.25}rem` }} className="flex flex-wrap items-baseline gap-x-3">
                <span className="font-mono text-sm">
                  <span aria-hidden className="text-ink-muted">{depth ? "└ " : ""}</span>
                  {name}
                </span>
                <span className="text-xs text-ink-muted">{kind}</span>
              </li>
            ))}
          </ul>
          <p className="mt-5 border-t border-rule pt-4 text-sm leading-relaxed text-ink-muted">
            Memberships are <span className="text-ink">soulbound</span> and expire with the
            perimeter — a hackathon&rsquo;s access lapses on its own when the event ends.
          </p>
        </Plate>

        <Plate className="p-5">
          <p className="label">Text records are the policy</p>
          <dl className="mt-4 space-y-3">
            {RECORDS.map(([k, v]) => (
              <div key={k}>
                <dt><Code>{k}</Code></dt>
                <dd className="text-sm text-ink-muted">{v}</dd>
              </div>
            ))}
          </dl>
        </Plate>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        {[
          ["Who may write what", "ENSv2 PermissionedResolver scopes ROLE_SET_TEXT per name and per key. A mentor may edit their own avatar — never another member's, never wifi.rate."],
          ["Roles are resources", "Custom roles (mentor, crew, volunteer) are EAC resources, not role bits — no ceiling on how many an org invents."],
          ["Authority follows the name", "Onboarding power is derived from your membership. Promote someone and they can onboard; revoke them and it's gone."],
        ].map(([t, d]) => (
          <div key={t} className="border-t border-ink pt-3">
            <p className="font-mono text-sm font-medium">{t}</p>
            <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">{d}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

const LIVE = [
  ["real member signs", "admitted · mentor · wifi.rate 20mbps"],
  ["stranger signs", "403"],
  ["replayed nonce", "401 · already used"],
  ["mentor writes hacker's avatar", "reverted · EACUnauthorizedAccountRoles"],
] as const;

const ROADMAP = [
  ["Next", "Hardware VLAN per identity — MikroTik + FreeRADIUS 802.1X"],
  ["Then", "ssh.pubkey → AuthorizedKeysCommand SSH"],
  ["Later", "Post-event attestations: hours online, APIs used, sponsors reached"],
] as const;

function ProofSlide() {
  return (
    <div>
      <Kicker n={7}>It runs</Kicker>
      <Heading>Live on a Fedora VM, a TP-Link AX80 and ENSv2 on Sepolia.</Heading>

      <div className="mt-8 grid gap-4 lg:grid-cols-[1.1fr_1fr]">
        <Plate className="overflow-hidden">
          <p className="label border-b border-rule px-5 py-3">Against the live deployment</p>
          <table className="w-full text-sm">
            <tbody>
              {LIVE.map(([who, result]) => (
                <tr key={who} className="border-b border-rule-soft last:border-0">
                  <td className="px-5 py-2.5 text-ink-muted">{who}</td>
                  <td className="px-5 py-2.5 text-right font-mono text-[0.8125rem]">{result}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="border-t border-rule px-5 py-3 text-sm text-ink-muted">
            <span className="font-mono text-ink">134</span> contract tests, 13 asserting the
            permission matrix against live Sepolia state.
          </p>
        </Plate>

        <div className="flex flex-col gap-3">
          <Plate className="p-5">
            <p className="label">Before → after</p>
            <ul className="mt-3 space-y-1.5 text-sm">
              {[
                ["Shared password", "ENS subname + signature"],
                ["One flat network", "Isolated group per role"],
                ["Keys on Discord", "Injected server-side"],
                ["No visibility", "Per-session audit log"],
              ].map(([a, b]) => (
                <li key={a} className="flex items-center gap-2">
                  <span className="text-ink-muted line-through decoration-ink-faint">{a}</span>
                  <ArrowRightIcon size={12} />
                  <span>{b}</span>
                </li>
              ))}
            </ul>
          </Plate>
          <Plate className="p-5">
            <p className="label">Roadmap</p>
            <ul className="mt-3 space-y-1.5 text-sm">
              {ROADMAP.map(([when, what]) => (
                <li key={when} className="grid grid-cols-[3.5rem_1fr] gap-2">
                  <span className="font-mono text-ink-muted">{when}</span>
                  <span>{what}</span>
                </li>
              ))}
            </ul>
          </Plate>
        </div>
      </div>

      <p className="mt-8 text-lg">
        Events today. Offices, campuses and co-working spaces tomorrow — same model, same names.
      </p>
    </div>
  );
}

/**
 * The turn: from what went wrong to what we built.
 *
 * Two pieces of evidence, because the claim has two halves — a box that sits in the venue and
 * enforces this in the kernel, and the next event it is meant for. The router is a drawn
 * placeholder rather than a stock photograph: the real one is a specific machine that will be
 * photographed, and a generic product shot would be standing in for evidence we do not have.
 */
function SolutionSlide() {
  return (
    <div className="grid items-center gap-10 lg:grid-cols-[0.9fr_1.1fr] lg:gap-12">
      <div>
        <Kicker n={3}>The solution</Kicker>
        <h2 className="mt-6 text-balance font-mono text-3xl font-medium leading-[1.05] tracking-[-0.03em] sm:text-4xl">
          So we built the thing that stops it.
        </h2>
        <p className="mt-6 text-balance text-2xl leading-snug sm:text-3xl">
          One box at the venue. One name per person.
        </p>
        <p className="mt-6 max-w-[48ch] leading-relaxed text-ink-muted">
          Nobody reaches for a hotspot when the network is worth staying on. Radius gives every
          attendee a share that is theirs — enforced in the kernel, bound to an ENS name rather
          than a device, so ten phones still get one person&rsquo;s bandwidth.
        </p>
        <p className="mt-6 max-w-[48ch] leading-relaxed text-ink-muted">
          Running at ETHGlobal Mumbai, November 2026.
        </p>
      </div>

      <div className="grid items-center gap-3 sm:grid-cols-[1fr_1.15fr]">
        <Shot
          src="/pitch/venue-router.jpeg"
          width={1251}
          height={1280}
          alt="The venue router that runs Radius, on a desk with its ethernet lead attached."
          aspect="aspect-[4/5]"
        />
        <div className="grid gap-3">
          <Shot
            src="/pitch/ethglobal-mumbai.png"
            width={2880}
            height={1436}
            alt="ETHGlobal Mumbai, 5–7 November 2026, Mumbai, India."
          />
          <p className="font-mono text-[0.6875rem] leading-relaxed text-ink-muted">
            One box at the door. Every attendee gets a share that is theirs.
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * The tree, and what a leaf actually gets.
 *
 * Every other way of drawing this — a list, three boxes, an architecture diagram — loses the one
 * property that matters: access is *positional*. A membership is a leaf, its perimeter is the
 * branch above it, and the organization is the root; nothing is granted sideways. Drawn as a
 * tree that is self-evident, and the grants can sit on the same row as the name they belong to
 * rather than in a legend somewhere else.
 *
 * The figures are the entitlement text records on those names, not illustrations of them.
 */
const ORG_TREE: {
  depth: number;
  name: string;
  role?: string;
  wifi?: string;
  api?: string;
  shell?: boolean;
  note?: string;
  last?: boolean;
}[] = [
  { depth: 0, name: "ethglobal.eth", note: "organization · owns the registry" },
  { depth: 1, name: "tokyo.ethglobal.eth", note: "perimeter · expires with the event" },
  { depth: 2, name: "ana.tokyo.ethglobal.eth", role: "organizer", wifi: "50 Mbit", api: "unlimited", shell: true },
  { depth: 2, name: "leo.tokyo.ethglobal.eth", role: "mentor", wifi: "20 Mbit", api: "2,000 / day", shell: false },
  { depth: 2, name: "sam.tokyo.ethglobal.eth", role: "hacker", wifi: "5 Mbit", api: "500 / day", shell: false },
  { depth: 2, name: "kit.tokyo.ethglobal.eth", role: "volunteer", wifi: "10 Mbit", api: "none", shell: false, last: true },
  { depth: 1, name: "mumbai.ethglobal.eth", note: "perimeter · November, not open yet", last: true },
];

function TreeSlide() {
  return (
    <div>
      <Kicker n={4}>The tree</Kicker>
      <Heading>Where a name sits is what it may do.</Heading>

      <Plate className="mt-8 overflow-x-auto p-5">
        <div className="min-w-[44rem]">
          <div className="grid grid-cols-[1fr_5.5rem_5.5rem_6rem_3.25rem] gap-x-4 border-b border-rule pb-2">
            <span className="label">Name</span>
            <span className="label">Role</span>
            <span className="label">WiFi</span>
            <span className="label">API</span>
            <span className="label">Shell</span>
          </div>

          <ul className="divide-y divide-rule-soft">
            {ORG_TREE.map((row) => (
              <li
                key={row.name}
                className="grid grid-cols-[1fr_5.5rem_5.5rem_6rem_3.25rem] items-baseline gap-x-4 py-2"
              >
                <span className="flex min-w-0 items-baseline font-mono text-sm">
                  <span aria-hidden className="whitespace-pre text-ink-faint">
                    {branchGlyph(row.depth, row.last)}
                  </span>
                  <span className={`truncate ${row.role ? "text-ink" : "font-medium text-ink"}`}>
                    {row.name}
                  </span>
                </span>

                {row.role ? (
                  <>
                    <span className="font-mono text-xs text-ink">{row.role}</span>
                    <span className="font-mono text-xs tabular-nums text-ink-muted">{row.wifi}</span>
                    <span className="font-mono text-xs tabular-nums text-ink-muted">{row.api}</span>
                    <span className="font-mono text-xs text-ink-muted">{row.shell ? "yes" : "—"}</span>
                  </>
                ) : (
                  <span className="col-span-4 text-xs text-ink-muted">{row.note}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      </Plate>

      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        {[
          [
            "The leaf carries the policy",
            "wifi.rate, wifi.ceil and the API quota are text records on that membership name. Reading the name is reading the rule.",
          ],
          [
            "Nothing is granted sideways",
            "A hacker cannot reach a mentor's bandwidth by asking for it — the class is derived from where the name sits, in the kernel.",
          ],
          [
            "The branch expires",
            "tokyo lapses when the event ends and every membership under it goes with it. Mumbai opens as its own perimeter.",
          ],
        ].map(([t, d]) => (
          <div key={t} className="border-t border-ink pt-3">
            <p className="font-mono text-sm font-medium">{t}</p>
            <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">{d}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

/** `tree(1)`'s own notation, because that is what a reader of monospace already knows. */
function branchGlyph(depth: number, last?: boolean) {
  if (depth === 0) return "";
  const elbow = last ? "└─ " : "├─ ";
  return depth === 1 ? elbow : `│  ${elbow}`;
}

const SLIDES = [
  { title: "Radius", render: TitleSlide },
  { title: "The problem", render: ProblemSlide },
  { title: "The solution", render: SolutionSlide },
  { title: "The tree", render: TreeSlide },
  { title: "How it works", render: HowSlide },
  { title: "The role of ENS", render: EnsSlide },
  { title: "It runs", render: ProofSlide },
] as const;

/* ── Deck chrome ─────────────────────────────────────────────────────────── */

function readHash() {
  const n = Number.parseInt(window.location.hash.slice(1), 10);
  return Number.isInteger(n) && n >= 1 && n <= SLIDES.length ? n - 1 : 0;
}

function subscribeHash(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

export function PitchDeck() {
  // The hash is the slide: a link to #4 opens on the ENS slide, and back/forward step through.
  const index = useSyncExternalStore(subscribeHash, readHash, () => 0);
  const [direction, setDirection] = useState(1);
  const reduceMotion = useReducedMotion();

  // Reads the current slide from the hash, not from render state: two quick key presses land
  // before the first hashchange re-renders, and a closed-over index would step once, not twice.
  const go = useCallback((step: (current: number) => number) => {
    const current = readHash();
    const next = Math.max(0, Math.min(SLIDES.length - 1, step(current)));
    if (next === current) return;
    setDirection(next > current ? 1 : -1);
    window.location.hash = String(next + 1);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (["ArrowRight", "PageDown", " "].includes(e.key)) {
        e.preventDefault();
        go((i) => i + 1);
      } else if (["ArrowLeft", "PageUp"].includes(e.key)) {
        e.preventDefault();
        go((i) => i - 1);
      } else if (e.key === "Home") go(() => 0);
      else if (e.key === "End") go(() => SLIDES.length - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);

  const Slide = SLIDES[index].render;
  const offset = reduceMotion ? 0 : 32;

  return (
    <div className="paper-grid flex h-svh flex-col">
      <header className="border-b border-rule bg-paper/80 backdrop-blur-sm">
        <div className="mx-auto flex h-14 w-full max-w-[1180px] items-center justify-between px-5">
          <Link href="/" className="flex items-center gap-1.5 text-ink">
            <WifiMark className="shrink-0" />
            <span className="font-mono text-sm font-medium tracking-[0.18em]">Radius</span>
          </Link>
          <p className="label" aria-live="polite">
            <span className="text-ink">{String(index + 1).padStart(2, "0")}</span> /{" "}
            {String(SLIDES.length).padStart(2, "0")} · {SLIDES[index].title}
          </p>
        </div>
      </header>

      <main id="main" className="relative flex-1 overflow-y-auto overflow-x-hidden">
        <AnimatePresence mode="wait" custom={direction} initial={false}>
          <motion.section
            key={index}
            aria-roledescription="slide"
            aria-label={`${index + 1} of ${SLIDES.length}: ${SLIDES[index].title}`}
            initial={{ opacity: 0, x: direction * offset }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -direction * offset }}
            transition={{ duration: reduceMotion ? 0.12 : 0.28, ease: [0.22, 1, 0.36, 1] }}
            className="mx-auto flex min-h-full w-full max-w-[1180px] flex-col justify-center px-5 py-10 lg:py-12"
          >
            <Slide />
          </motion.section>
        </AnimatePresence>
      </main>

      <footer className="border-t border-rule bg-paper/80 backdrop-blur-sm">
        <div className="mx-auto flex h-16 w-full max-w-[1180px] items-center justify-between gap-4 px-5">
          <button
            type="button"
            onClick={() => go((i) => i - 1)}
            disabled={index === 0}
            className="inline-flex h-11 items-center gap-2 rounded-full border border-ink/35 px-4 font-mono text-xs uppercase tracking-[0.12em] transition-colors hover:border-ink hover:bg-ink/5 disabled:pointer-events-none disabled:opacity-40"
          >
            <span className="rotate-180"><ArrowRightIcon size={13} /></span>
            Prev
          </button>

          <nav aria-label="Slides" className="flex items-center gap-1">
            {SLIDES.map((s, i) => (
              <button
                key={s.title}
                type="button"
                onClick={() => go(() => i)}
                aria-label={`Slide ${i + 1}: ${s.title}`}
                aria-current={i === index ? "step" : undefined}
                className="group flex h-11 w-7 items-center justify-center"
              >
                <span
                  className={`block h-1 rounded-full transition-all ${
                    i === index ? "w-6 bg-ink" : "w-2.5 bg-ink-faint group-hover:bg-ink-muted"
                  }`}
                />
              </button>
            ))}
          </nav>

          <button
            type="button"
            onClick={() => go((i) => i + 1)}
            disabled={index === SLIDES.length - 1}
            className="inline-flex h-11 items-center gap-2 rounded-full border border-ink bg-ink px-4 font-mono text-xs uppercase tracking-[0.12em] text-paper transition-colors hover:bg-ink-80 disabled:pointer-events-none disabled:opacity-40"
          >
            Next
            <ArrowRightIcon size={13} />
          </button>
        </div>
      </footer>
    </div>
  );
}
