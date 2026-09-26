import { Wizard } from "@/components/create/Wizard";
import { SiteHeader } from "@/components/SiteHeader";

export const metadata = { title: "Create an organization — Radius" };

export default function CreatePage() {
  return (
    <>
      <SiteHeader />
      {/* Full-bleed on the grid paper, like the landing. The page used to sit in a 1180px box
          with the texture stopping at its edges, which made the setup flow look like a form
          bolted onto the product rather than a part of it. */}
      <main id="main" className="paper-grid flex flex-1 flex-col">
        <div className="mx-auto w-full max-w-[1340px] px-5 py-12 lg:px-8 lg:py-16">
          <header className="max-w-[40ch]">
            {/* The display voice the rest of the product uses. At text-3xl this heading was
                quieter than the hero's body copy, on the page where somebody commits to
                deploying four contracts. */}
            <h1 className="font-mono text-4xl font-medium leading-[0.95] tracking-[-0.04em] text-ink sm:text-5xl lg:text-6xl">
              Create an
              <br />
              organization
            </h1>
            <p className="mt-6 max-w-[44ch] text-base leading-relaxed text-ink-muted">
              Six steps, in the only order they can happen — each one needs the thing before it
              to exist.
            </p>
          </header>

          <div className="mt-12 lg:mt-16">
            <Wizard />
          </div>
        </div>
      </main>
    </>
  );
}
