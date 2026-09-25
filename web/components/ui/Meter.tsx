/**
 * Single-series utilisation meter: one group's consumption against its pool.
 * Identity comes from the labelled row, not from hue, so no categorical
 * palette is involved. Over-cap is flagged with colour *and* a text label,
 * never colour alone.
 */
export function Meter({
  label,
  used,
  cap,
  unit = "Mbps",
  detail,
}: {
  label: string;
  used: number;
  cap: number;
  unit?: string;
  detail?: string;
}) {
  const ratio = cap > 0 ? Math.min(used / cap, 1) : 0;
  const pct = Math.round((cap > 0 ? used / cap : 0) * 100);
  const strained = pct >= 90;

  return (
    <div className="px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-mono text-xs tracking-wide text-ink">{label}</span>
        <span className="font-mono text-xs tabular-nums text-ink-55">
          {used.toLocaleString()} / {cap.toLocaleString()} {unit}
        </span>
      </div>

      <div
        className="mt-2 h-2 w-full bg-ink/8 rounded-[1px] overflow-hidden"
        role="meter"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${label} bandwidth utilisation`}
      >
        <div
          className="h-full rounded-r-[4px]"
          style={{
            width: `${ratio * 100}%`,
            background: strained ? "var(--alert)" : "var(--signal)",
          }}
        />
      </div>

      <div className="mt-1.5 flex items-baseline justify-between gap-3">
        <span className="text-xs text-ink-55">{detail}</span>
        <span
          className="font-mono text-xs tabular-nums"
          style={{ color: strained ? "var(--alert)" : "var(--ink-55)" }}
        >
          {pct}%{strained ? " · at cap" : ""}
        </span>
      </div>
    </div>
  );
}
