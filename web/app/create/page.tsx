import { Wizard } from "@/components/create/Wizard";
import { SiteHeader } from "@/components/SiteHeader";

export const metadata = { title: "Create an organization — Radius" };

export default function CreatePage() {
  return (
    <>
      <SiteHeader />
      <main id="main" className="mx-auto w-full max-w-[1180px] flex-1 px-5 py-10 lg:px-8">
        <header className="mb-10 max-w-[46ch]">
          <h1 className="text-3xl tracking-[-0.02em] text-ink lg:text-4xl">
            Create an organization
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-ink-muted">
            Six steps, in the only order they can happen — each one needs the thing before it to
            exist.
          </p>
        </header>
        <Wizard />
      </main>
    </>
  );
}
