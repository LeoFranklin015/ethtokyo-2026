import { Wizard } from "@/components/create/Wizard";
import { SiteHeader } from "@/components/SiteHeader";

export const metadata = { title: "Create an organization — Radius" };

export default function CreatePage() {
  return (
    <>
      <SiteHeader />
      {/* One screen, centred. The flow used to be a plate pinned to the top-left of a tall page
          with the weather beside it; the step you are on is the only thing that matters here, so
          it gets the viewport and the signal runs behind the whole of it. */}
      <main
        id="main"
        className="relative flex flex-1 items-center justify-center overflow-hidden px-5 py-14 lg:min-h-[calc(100svh-3.5rem)] lg:py-16"
      >
        <Wizard />
      </main>
    </>
  );
}
