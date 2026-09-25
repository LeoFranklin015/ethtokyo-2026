import { SiteHeader } from "@/components/SiteHeader";
import { SignalDither } from "@/components/dither/SignalDither";
import { ButtonLink } from "@/components/ui/Button";

const SPEC = [
  ["Auth", "EIP-191 signature"],
  ["Policy", "ENS text records"],
  ["Access", "EAC role bitmap"],
  ["Enforce", "VLAN + HTB class"],
];

export default function Home() {
  return (
    <>
      <SiteHeader />

      <main id="main" className="mx-auto flex w-full max-w-[1180px] flex-1 flex-col px-5">
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
                <p className="mt-4 max-w-[46ch] text-sm leading-relaxed text-ink-muted">
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
              <SignalDither
                motif="wifi"
                interactive
                className="absolute inset-0"
                label="Wifi signal, rendered as an animated ordered dither"
              />
            </div>
          </div>

          <dl className="grid grid-cols-2 border-t border-ink/20 sm:grid-cols-4">
            {SPEC.map(([term, detail], i) => (
              <div
                key={term}
                className={`px-4 py-3 ${i % 2 === 0 ? "border-r border-ink/20" : ""} sm:border-r sm:last:border-r-0 ${
                  i < 2 ? "border-b border-ink/20 sm:border-b-0" : ""
                }`}
              >
                <dt className="label">{term}</dt>
                <dd className="mt-1.5 font-mono text-xs text-ink-80">{detail}</dd>
              </div>
            ))}
          </dl>
        </section>
      </main>
    </>
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
