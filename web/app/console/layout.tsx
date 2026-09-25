import { Sidebar } from "@/components/console/Sidebar";

export default function ConsoleLayout({ children }: LayoutProps<"/console">) {
  return (
    <div className="flex min-h-full flex-1 flex-col lg:flex-row">
      {/* Sidebar: a rail on desktop, a stacked header strip on narrow screens */}
      <aside className="shrink-0 border-b border-rule lg:h-dvh lg:w-[232px] lg:sticky lg:top-0 lg:border-b-0 lg:border-r">
        <Sidebar />
      </aside>

      <div id="main" className="min-w-0 flex-1">
        {children}
      </div>
    </div>
  );
}
