/**
 * A hero number. No plot, so no legend and no hover layer — the label names
 * the measure and the unit sits beside the value rather than inside it.
 */
export function Stat({
  label,
  value,
  unit,
  note,
}: {
  label: string;
  value: string;
  unit?: string;
  note?: string;
}) {
  return (
    <div className="px-4 py-4">
      <p className="label">{label}</p>
      <p className="mt-2 flex items-baseline gap-1.5">
        <span className="font-mono text-3xl leading-none tabular-nums tracking-tight text-ink">
          {value}
        </span>
        {unit ? <span className="font-mono text-xs text-ink-55">{unit}</span> : null}
      </p>
      {note ? <p className="mt-1.5 text-xs text-ink-55">{note}</p> : null}
    </div>
  );
}
