import Link from "next/link";

const NAV = [
  { href: "/console", label: "Console" },
  { href: "/portal", label: "Portal" },
] as const;

export function SiteHeader({ current }: { current?: string }) {
  return (
    <header className="border-b border-rule">
      <div className="mx-auto flex h-14 w-full max-w-[1180px] items-center justify-between gap-6 px-5">
        <Link href="/" className="flex items-baseline gap-2.5">
          <span className="font-mono text-sm font-medium tracking-[0.18em] text-ink">ENSCA</span>
          <span className="hidden font-mono text-[0.6875rem] text-ink-35 sm:inline">
            ethglobal.eth
          </span>
        </Link>

        <nav aria-label="Primary">
          <ul className="flex items-center gap-1">
            {NAV.map((item) => {
              const active = current === item.href;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={`rounded-full px-3 py-1.5 font-mono text-[0.6875rem] uppercase tracking-[0.12em] transition-colors ${
                      active ? "bg-ink text-paper" : "text-ink-55 hover:bg-ink/5 hover:text-ink"
                    }`}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>
    </header>
  );
}
