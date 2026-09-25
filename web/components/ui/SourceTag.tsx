/**
 * Marks where a panel's numbers come from. The console mixes data read live from ENSv2 with
 * enforcer telemetry that has no on-chain source yet; saying which is which keeps the demo honest.
 */
export function SourceTag({ source }: { source: "chain" | "enforcer" }) {
  const onChain = source === "chain";
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[0.6875rem] uppercase tracking-[0.1em] text-ink-muted">
      <span
        aria-hidden
        className="size-1.5 rounded-full"
        style={{ background: onChain ? "var(--signal)" : "var(--ink-faint)" }}
      />
      {onChain ? "on-chain" : "enforcer"}
    </span>
  );
}
