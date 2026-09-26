"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { WalletButton } from "@/components/WalletButton";
import { WifiMark } from "@/components/WifiMark";

const NAV = [
  { href: "/create", label: "Create org" },
  { href: "/console", label: "Console" },
] as const;

export function SiteHeader() {
  // Derived, not passed. Every page had to remember to declare which one it was, and the home
  // page never did — so its own link was never marked current.
  const current = usePathname();

  return (
    <header className="border-b border-rule">
      {/* Two rows on a phone, one on everything else. The logo, three nav items and the wallet
          do not fit on one line at 320px, and letting them wrap freely left the wallet — the one
          control this page actually needs — stranded mid-row. So the grid places it beside the
          logo and gives the nav a line of its own. */}
      <div className="mx-auto grid min-h-14 w-full max-w-[1180px] grid-cols-[auto_1fr] items-center gap-x-4 gap-y-0.5 px-5 py-1.5 sm:flex sm:justify-between sm:gap-6 sm:py-0">
        <Link href="/" className="flex items-center gap-1.5 text-ink">
          <WifiMark className="shrink-0" />
          <span className="font-mono text-sm font-medium tracking-[0.18em]">Radius</span>
        </Link>

        <span className="shrink-0 justify-self-end sm:order-3">
          <WalletButton compact />
        </span>

        <nav aria-label="Primary" className="col-span-2 sm:order-2 sm:col-auto sm:ml-auto">
          <ul className="flex flex-wrap items-center gap-0.5 sm:gap-1">
            {NAV.map((item) => {
              const active = current === item.href;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={`inline-flex min-h-11 items-center whitespace-nowrap rounded-full px-2.5 font-mono text-[0.6875rem] uppercase tracking-[0.12em] transition-colors sm:px-3 ${
                      active ? "bg-ink text-paper" : "text-ink-muted hover:bg-ink/5 hover:text-ink"
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
