/** Shown instead of a number when a real source cannot be read. Never a placeholder value. */
export function Unavailable({
  what,
  hint,
}: {
  what: string;
  hint?: string;
}) {
  return (
    <div role="status" className="px-4 py-10 text-center">
      <p className="font-mono text-xs uppercase tracking-[0.12em] text-ink-muted">{what}</p>
      {hint ? (
        <p className="mx-auto mt-2 max-w-[44ch] text-xs leading-relaxed text-ink-muted">{hint}</p>
      ) : null}
    </div>
  );
}
