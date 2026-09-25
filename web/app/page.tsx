import { Rail } from "@/components/Rail";
import { SiteHeader } from "@/components/SiteHeader";
import { WifiDither } from "@/components/dither/WifiDither";
import { ButtonLink } from "@/components/ui/Button";
import { Panel } from "@/components/ui/Panel";
import { REPLACEMENTS, ROLES } from "@/lib/data";

const HIERARCHY = [
  { term: "Organization", ens: "acme.eth", note: "Trust root. Defines the role catalogue." },
  { term: "Branch", ens: "tokyo.acme.eth", note: "A location. Its own registry, its own window." },
  { term: "Member", ens: "leo.acme.eth", note: "The person. Minted once, follows them everywhere." },
  { term: "Membership", ens: "leo.tokyo.acme.eth", note: "Their standing here. Carries one role." },
];

export default function Home() {
  return (
    <>
      <SiteHeader />

      <main id="main" className="mx-auto w-full max-w-[1180px] flex-1 px-5">
        {/* Hero ─────────────────────────────────────────────────────────── */}
        <section className="relative mt-6 border border-ink/45 paper-grid sm:mt-10">
          <CornerTicks />
          <div className="grid items-stretch gap-8 p-6 sm:p-10 lg:grid-cols-[1.05fr_0.95fr] lg:gap-4">
            <div className="flex flex-col justify-between gap-10">
              <div>
                <p className="label">Identity-gated infrastructure</p>
                <h1 className="mt-5 font-mono text-5xl font-medium leading-[0.95] tracking-[-0.03em] text-ink sm:text-6xl">
                  ENSCA
                </h1>
                <p className="mt-5 max-w-[34ch] text-balance text-lg leading-snug text-ink-80 sm:text-xl">
                  Your ENS subname is the credential for the network, the shell and the
                  API — at every location you operate.
                </p>
                <p className="mt-4 max-w-[46ch] text-sm leading-relaxed text-ink-55">
                  Roles, bandwidth and isolation are read straight from ENS text records.
                  No password on a slide. No user database on the box.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2.5">
                <ButtonLink href="/console" variant="solid">
                  Open console
                </ButtonLink>
                <ButtonLink href="/portal">See the portal</ButtonLink>
              </div>
            </div>

            <div className="relative min-h-[260px] sm:min-h-[320px]">
              <WifiDither
                className="absolute inset-0"
                label="Wifi signal, rendered as an animated ordered dither"
              />
            </div>
          </div>

          <dl className="grid grid-cols-2 border-t border-ink/20 sm:grid-cols-4">
            {[
              ["Auth", "EIP-191 signature"],
              ["Policy", "ENS text records"],
              ["Access", "EAC role bitmap"],
              ["Enforce", "VLAN + HTB class"],
            ].map(([term, detail]) => (
              <div key={term} className="border-r border-ink/20 px-4 py-3 last:border-r-0">
                <dt className="label">{term}</dt>
                <dd className="mt-1.5 font-mono text-xs text-ink-80">{detail}</dd>
              </div>
            ))}
          </dl>
        </section>

        {/* What it replaces ─────────────────────────────────────────────── */}
        <Rail label="What it replaces" className="mt-16">
          {REPLACEMENTS.map((item) => (
            <Panel
              key={item.before}
              as="article"
              className="w-[260px] shrink-0 snap-start p-4 sm:w-[300px]"
            >
              <p className="label">Before</p>
              <p className="mt-1.5 text-sm leading-snug text-ink-55 line-through decoration-ink-35">
                {item.before}
              </p>
              <hr className="my-4 border-rule" />
              <p className="label">After</p>
              <p className="mt-1.5 text-sm leading-snug text-ink">{item.after}</p>
            </Panel>
          ))}
        </Rail>

        {/* Hierarchy ────────────────────────────────────────────────────── */}
        <section className="mt-16" aria-labelledby="hierarchy-heading">
          <h2 id="hierarchy-heading" className="label">
            One tree, any organization
          </h2>
          <ol className="mt-3 border border-rule">
            {HIERARCHY.map((level, i) => (
              <li
                key={level.term}
                className="grid gap-1 border-b border-rule px-4 py-4 last:border-b-0 sm:grid-cols-[auto_180px_1fr] sm:items-baseline sm:gap-6"
                style={{ paddingLeft: `calc(1rem + ${i * 1.25}rem)` }}
              >
                <span className="font-mono text-xs uppercase tracking-[0.12em] text-ink">
                  {level.term}
                </span>
                <span className="font-mono text-xs text-signal">{level.ens}</span>
                <span className="text-sm text-ink-55">{level.note}</span>
              </li>
            ))}
          </ol>
        </section>

        {/* Roles ────────────────────────────────────────────────────────── */}
        <Rail label="Roles and what they get" className="mt-16">
          {ROLES.map((role) => (
            <Panel key={role.name} as="article" className="w-[250px] shrink-0 snap-start">
              <div className="flex items-baseline justify-between border-b border-rule px-4 py-3">
                <h3 className="font-mono text-sm tracking-wide text-ink">{role.name}</h3>
                <span className="font-mono text-[0.6875rem] text-ink-35">vlan {role.vlan}</span>
              </div>
              <dl className="px-4 py-3 text-xs">
                <Row term="Group" detail={role.group} />
                <Row term="Rate" detail={`${role.rate} / ${role.ceil} Mbps`} />
                <Row
                  term="Permissions"
                  detail={role.permissions.length ? role.permissions.join(", ") : "none"}
                />
              </dl>
              <p className="border-t border-rule px-4 py-3 text-xs leading-relaxed text-ink-55">
                {role.summary}
              </p>
            </Panel>
          ))}
        </Rail>
      </main>

      <footer className="mt-20 border-t border-rule">
        <div className="mx-auto flex w-full max-w-[1180px] flex-wrap items-center justify-between gap-3 px-5 py-6">
          <p className="font-mono text-[0.6875rem] tracking-[0.12em] text-ink-35">
            ENSCA · ETHTOKYO 2026
          </p>
          <p className="font-mono text-[0.6875rem] text-ink-35">ENSv2 · Sepolia</p>
        </div>
      </footer>
    </>
  );
}

function Row({ term, detail }: { term: string; detail: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="text-ink-35">{term}</dt>
      <dd className="text-right font-mono text-ink-80">{detail}</dd>
    </div>
  );
}

/** Engineering-drawing corner marks on the hero plate. */
function CornerTicks() {
  const corners = [
    "left-[-1px] top-[-1px] border-l border-t",
    "right-[-1px] top-[-1px] border-r border-t",
    "left-[-1px] bottom-[-1px] border-b border-l",
    "right-[-1px] bottom-[-1px] border-b border-r",
  ];
  return (
    <>
      {corners.map((c) => (
        <span key={c} aria-hidden className={`absolute size-3 border-ink ${c}`} />
      ))}
    </>
  );
}
