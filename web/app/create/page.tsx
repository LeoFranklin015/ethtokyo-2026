import { Wizard } from "@/components/create/Wizard";
import { SiteHeader } from "@/components/SiteHeader";

export const metadata = { title: "Create an organization — ENSCA" };

export default function CreatePage() {
  return (
    <>
      <SiteHeader current="/create" />
      <main id="main" className="mx-auto w-full max-w-[1180px] flex-1 px-5 py-10 lg:px-8">
        <header className="mb-8 max-w-[52ch]">
          <p className="label">Set up</p>
          <h1 className="mt-3 text-2xl tracking-[-0.02em] text-ink lg:text-3xl">
            Create an organization
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-ink-muted">
            Each step in the only order it can happen: the organization owns a name, a branch
            lives under it, groups are defined by the branch, and people are onboarded into groups.
          </p>
        </header>
        <Wizard />
      </main>
    </>
  );
}
