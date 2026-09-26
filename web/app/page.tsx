import { SiteHeader } from "@/components/SiteHeader";
import { SignalDither } from "@/components/dither/SignalDither";
import { ButtonLink } from "@/components/ui/Button";


export default function Home() {
  return (
    <>
      <SiteHeader />

      {/* Full-bleed hero. The grid paper is the page texture, not a framed plate. */}
      <main
        id="main"
        className="paper-grid flex flex-1 flex-col lg:min-h-[calc(100svh-3.5rem)]"
      >
        <div className="mx-auto grid w-full max-w-[1280px] flex-1 items-center gap-10 px-5 py-14 lg:grid-cols-[1fr_1.05fr] lg:gap-12 lg:py-0">
          <div>
            <p className="label">Identity-gated infrastructure</p>

            <h1 className="mt-6 font-mono text-6xl font-medium leading-[0.9] tracking-[-0.04em] text-ink sm:text-7xl lg:text-8xl">
              Radius
            </h1>

            <p className="mt-7 max-w-[24ch] text-balance text-2xl leading-[1.15] tracking-[-0.01em] text-ink sm:text-3xl lg:text-4xl">
              Your ENS subname is the credential.
            </p>

            <p className="mt-5 max-w-[48ch] text-base leading-relaxed text-ink-muted">
              One name gates the network, the shell and the API — at every location you
              operate. Roles, bandwidth and isolation are read straight from ENS text
              records. No password on a slide. No user database on the box.
            </p>

            <div className="mt-9 flex flex-wrap items-center gap-2.5">
              <ButtonLink href="/console" variant="solid">
                Open console
              </ButtonLink>
            </div>
          </div>

          <div className="relative min-h-[300px] self-stretch sm:min-h-[380px] lg:min-h-[min(72vh,620px)]">
            <SignalDither
              motif="wifi"
              interactive
              cell={4}
              className="absolute inset-0"
              label="Wifi signal, rendered as an animated ordered dither"
            />
          </div>
        </div>

      </main>
    </>
  );
}
