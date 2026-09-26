"use client";

import Link from "next/link";
import { useState } from "react";
import { usePathname } from "next/navigation";
import { SignalDither } from "@/components/dither/SignalDither";
import { useProxyStatus } from "@/lib/hooks/useProxyStatus";
import { useEnsBranches } from "@/lib/hooks/useEns";
import { useOrg, withOrg } from "@/lib/hooks/useOrg";
import { WalletButton } from "@/components/WalletButton";
import { WifiMark } from "@/components/WifiMark";
import { useConsoleSession } from "@/lib/hooks/useConsoleSession";

const SECTIONS = [
  {
    heading: "Operate",
    items: [
      { href: "/console", label: "Overview" },
      { href: "/console/people", label: "People" },
    ],
  },
  {
    heading: "Configure",
    items: [
      { href: "/console/groups", label: "Groups" },
      { href: "/console/branches", label: "Perimeters" },
    ],
  },
  {
    heading: "Enforcer",
    items: [
      { href: "/console/resources", label: "Resources" },
      { href: "/console/access", label: "Access" },
    ],
  },
] as const;

export function Sidebar() {
  const pathname = usePathname();
  const org = useOrg();
  const { branches } = useEnsBranches(org);
  const { data: status, error: statusError, isLoading: statusLoading } = useProxyStatus();
  const activeLabel = pathname.startsWith("/console/branches/")
    ? pathname.split("/console/branches/")[1]?.split("?")[0]
    : null;
  const [expanded, setExpanded] = useState<string | null>(activeLabel ?? null);
  const { session } = useConsoleSession();

  // Three states, not two. "Not yet answered" rendered as "unreachable" meant the first paint
  // of every console page accused the enforcer of being down.
  const enforcer = statusError
    ? { colour: "var(--alert)", label: "Enforcer unreachable" }
    : statusLoading || !status
      ? { colour: "var(--ink-faint)", label: "Checking the enforcer…" }
      : status.status === "ok"
        ? { colour: "var(--signal)", label: "Enforcer online" }
        : { colour: "var(--alert)", label: `Enforcer ${status.status}` };

  return (
    <div className="flex h-full flex-col">
      {/* Org identity */}
      <div className="border-b border-rule px-4 py-4 lg:px-5">
        <Link href="/" className="flex items-center gap-1.5 text-ink">
          <WifiMark className="shrink-0" />
          <span className="font-mono text-sm font-medium tracking-[0.18em]">Radius</span>
        </Link>
        <p className="mt-1 truncate font-mono text-[0.6875rem] text-ink-muted">{org ? `${org}.eth` : "no organization"}</p>
      </div>

      {/* Perimeters — collapsible, each links to its detail page */}
      <div className="border-b border-rule px-2 py-3 lg:px-3">
        <div className="flex items-center justify-between px-2 pb-1.5">
          <Link
            href={withOrg("/console/branches", org)}
            className="label hover:text-ink transition-colors"
          >
            Perimeters
          </Link>
        </div>
        <ul className="space-y-0.5">
          {branches === undefined ? (
            <li className="px-2 font-mono text-xs text-ink-faint">discovering…</li>
          ) : branches.length === 0 ? (
            <li className="px-2 font-mono text-xs text-ink-faint">none yet</li>
          ) : (
            branches.map((b) => {
              const isActive = activeLabel === b.label;
              const isOpen = expanded === b.label;
              const href = withOrg(`/console/branches/${b.label}`, org);
              return (
                <li key={b.name}>
                  <div className={`flex items-center rounded-sharp transition-colors ${isActive ? "bg-ink/8" : "hover:bg-ink/5"}`}>
                    <Link
                      href={href}
                      className="flex min-h-9 flex-1 items-center gap-1.5 px-2 font-mono text-xs"
                    >
                      <span
                        aria-hidden
                        className="h-3 w-px shrink-0"
                        style={{ background: isActive ? "var(--signal)" : "transparent" }}
                      />
                      <span className={`truncate ${isActive ? "text-ink font-medium" : "text-ink-muted"}`}>
                        {b.label}
                      </span>
                      {b.memberCount !== null ? (
                        <span className="ml-auto shrink-0 tabular-nums text-ink-faint text-[0.6rem]">
                          ({b.memberCount})
                        </span>
                      ) : null}
                    </Link>
                    <button
                      type="button"
                      aria-label={isOpen ? "Collapse" : "Expand"}
                      onClick={() => setExpanded(isOpen ? null : b.label)}
                      className="flex h-9 w-7 shrink-0 items-center justify-center text-ink-faint hover:text-ink transition-colors"
                    >
                      <svg
                        width="10" height="10" viewBox="0 0 10 10" fill="none"
                        aria-hidden
                        style={{ transform: isOpen ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s" }}
                      >
                        <path d="M3 2l4 3-4 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                  </div>
                  {isOpen ? (
                    <ul className="ml-4 mt-0.5 space-y-0.5 border-l border-rule pl-2">
                      {[
                        { label: "Groups", anchor: "groups" },
                        { label: "Members", anchor: "members" },
                      ].map(({ label: subLabel, anchor }) => (
                        <li key={anchor}>
                          <Link
                            href={`${href}#${anchor}`}
                            className="flex min-h-8 items-center px-2 font-mono text-[0.6875rem] text-ink-muted hover:text-ink transition-colors rounded-sharp hover:bg-ink/5"
                          >
                            {subLabel}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })
          )}
        </ul>
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
                      href={withOrg(item.href, org)}
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
            <span aria-hidden className="size-1.5 rounded-full" style={{ background: enforcer.colour }} />
            {enforcer.label}
          </p>
        </div>
        <div className="border-t border-rule px-5 py-3">
          <WalletButton compact />
        </div>
        <div className="border-t border-rule px-5 py-2.5">
          <Link
            href="/console"
            className="font-mono text-[0.6875rem] text-ink-muted underline decoration-rule underline-offset-2 hover:text-ink"
          >
            Switch organization
          </Link>
        </div>
        <div className="border-t border-rule px-5 py-2.5">
          {session ? (
            <p className="flex items-center gap-2 font-mono text-[0.6875rem] text-ink-muted">
              <span aria-hidden className="size-1.5 rounded-full" style={{ background: "var(--signal)" }} />
              Owner of {session.org}.eth
            </p>
          ) : (
            <Link
              href="/console/signin"
              className="font-mono text-[0.6875rem] text-ink-muted underline decoration-rule underline-offset-2 hover:text-ink"
            >
              Prove ownership to edit
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
