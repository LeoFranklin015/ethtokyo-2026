import { ConsoleGate } from "@/components/console/ConsoleGate";
import { Sidebar } from "@/components/console/Sidebar";

export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  return (
    // The shell is the reward for passing the gate, not the frame around it. It used to be
    // rendered unconditionally, so a visitor with no wallet got the nav, the perimeter list and
    // the enforcer status beside a connect prompt — an inventory of everything they could not
    // reach, with figures they were not actually being shown.
    <ConsoleGate>
      <div className="flex min-h-full flex-1 flex-col lg:flex-row">
        {/* Sidebar: a rail on desktop, a stacked header strip on narrow screens */}
        <aside className="shrink-0 border-b border-rule lg:h-dvh lg:w-[232px] lg:sticky lg:top-0 lg:border-b-0 lg:border-r">
          <Sidebar />
        </aside>

        <div id="main" className="min-w-0 flex-1">
          {children}
        </div>
      </div>
    </ConsoleGate>
  );
}
