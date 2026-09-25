import type { RoleName } from "@/lib/data";

/** Role identity is carried by the text itself; the dot is a secondary cue. */
export function RoleChip({ role }: { role: RoleName }) {
  return (
    <span className="inline-flex items-center gap-1.5 border border-rule rounded-full px-2 py-0.5 font-mono text-[0.6875rem] uppercase tracking-[0.1em] text-ink-80">
      <span aria-hidden className="size-1 rounded-full bg-ink-faint" />
      {role}
    </span>
  );
}
