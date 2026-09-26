"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SignalDither } from "@/components/dither/SignalDither";
import { useProxyStatus } from "@/lib/hooks/useProxyStatus";

const SECTIONS = [
  {
    heading: "Branch",
    items: [
      { href: "/console", label: "Overview" },
      { href: "/console/members", label: "Memberships" },
      { href: "/console/roles", label: "Roles" },
    ],
  },
  {
    heading: "Organization",
    items: [{ href: "/console/branches", label: "Branches" }],
  },
] as const;

export function Sidebar() {
  const pathname = usePathname();
  const { data: status } = useProxyStatus();
  const branchLabel = process.env.NEXT_PUBLIC_BRANCH_LABEL ?? "branch";

  const online = !!status && status.status === "ok";

  return (
    <div className="flex h-full flex-col">
      {/* Org identity */}
      <div className="border-b border-rule px-4 py-4 lg:px-5">
        <Link href="/" className="flex items-center">
          <span className="font-mono text-sm font-medium tracking-[0.18em] text-ink">ENSCA</span>
        </Link>
      </div>

      {/* Branch label — single branch, no switcher */}
      <div className="border-b border-rule px-4 py-3 lg:px-5">
        <p className="label">Branch</p>
        <p className="mt-2 font-mono text-xs text-ink">{branchLabel}</p>
      </div>

      {/* Navigation */}
      <nav aria-label="Console" className="flex-1 overflow-y-auto px-2 py-3 lg:px-3">
        {SECTIONS.map((section) => (
          <div key={section.heading} className="mb-4 last:mb-0">
            <p className="label px-2 pb-2">{section.heading}</p>
            <ul>
              {section.items.map((item) => {
                const active = pathname === item.href;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={`flex min-h-11 items-center gap-2.5 rounded-sharp px-2 text-sm transition-colors ${
                        active ? "bg-ink/8 font-medium text-ink" : "text-ink-muted hover:bg-ink/5 hover:text-ink"
                      }`}
                    >
                      <span
                        aria-hidden
                        className="h-4 w-px"
                        style={{ background: active ? "var(--signal)" : "transparent" }}
                      />
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      {/* Enforcer status */}
      <div className="hidden border-t border-rule lg:block">
        <div className="relative h-12">
          <SignalDither motif="waveform" cell={2} period={5} intensity={0.45} className="absolute inset-0" />
        </div>
        <div className="border-t border-rule px-5 py-3">
          <p className="flex items-center gap-2 font-mono text-[0.6875rem] text-ink-muted">
            <span aria-hidden className="size-1.5 rounded-full" style={{ background: online ? "var(--signal)" : "var(--alert)" }} />
            {online ? "Proxy online" : "Proxy unreachable"}
          </p>
          {status && <p className="mt-1 font-mono text-[0.6875rem] text-ink-muted">{status.active_sessions} active sessions</p>}
        </div>
      </div>
    </div>
  );
}
