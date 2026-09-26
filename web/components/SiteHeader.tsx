"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { WalletButton } from "@/components/WalletButton";

const NAV = [
  { href: "/create", label: "Create org" },
  { href: "/console", label: "Console" },
  { href: "/portal", label: "Portal" },
] as const;

export function SiteHeader() {
  // Derived, not passed. Every page had to remember to declare which one it was, and the home
  // page never did — so its own link was never marked current.
  const current = usePathname();

  return (
    <header className="border-b border-rule">
      <div className="mx-auto flex h-14 w-full max-w-[1180px] items-center justify-between gap-6 px-5">
        <Link href="/" className="flex items-center">
          <span className="font-mono text-sm font-medium tracking-[0.18em] text-ink">ENSCA</span>
        </Link>

        <div className="flex items-center gap-4">
          <nav aria-label="Primary">
          <ul className="flex items-center gap-1">
            {NAV.map((item) => {
              const active = current === item.href;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={`inline-flex min-h-11 items-center rounded-full px-3 font-mono text-[0.6875rem] uppercase tracking-[0.12em] transition-colors ${
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
          <WalletButton compact />
        </div>
      </div>
    </header>
  );
}
