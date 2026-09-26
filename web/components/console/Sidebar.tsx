"use client";

import Link from "next/link";
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
    // The enforcer is one deployment, not one organization — it has no organization column, so
    // these are deliberately not `?org=`-scoped and each says so on screen. Users is the
    // exception: its rows are people, which the enforcer matches by the ENS name's suffix, so
    // that page does need the organization and carries it.
    heading: "Enforcer",
    orgScoped: false,
    items: [
      { href: "/console/resources", label: "Resources" },
      { href: "/console/access", label: "Access" },
      { href: "/console/users", label: "Users", orgScoped: true },
    ],
  },
] as const;

export function Sidebar() {
  const pathname = usePathname();
  const org = useOrg();
  const { branches } = useEnsBranches(org);
  const { data: status, error: statusError, isLoading: statusLoading } = useProxyStatus();
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

      {/* Branches, discovered from ENS rather than configured */}
      <div className="border-b border-rule px-4 py-3 lg:px-5">
        <p className="label">Perimeters</p>
        <ul className="mt-2 space-y-1">
          {branches === undefined ? (
            <li className="font-mono text-xs text-ink-muted">discovering…</li>
          ) : branches.length === 0 ? (
            <li className="font-mono text-xs text-ink-muted">none yet</li>
          ) : (
            branches.map((b) => (
              <li key={b.name} className="flex items-baseline justify-between gap-2">
                <span className="truncate font-mono text-xs text-ink">{b.label}</span>
                <span className="shrink-0 font-mono text-[0.6875rem] tabular-nums text-ink-muted">
                  {b.memberCount}
                </span>
              </li>
            ))
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
                      href={
                        ("orgScoped" in item ? item.orgScoped : !("orgScoped" in section) || section.orgScoped)
                          ? withOrg(item.href, org)
                          : item.href
                      }
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
