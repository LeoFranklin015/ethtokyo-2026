/**
 * The Radius mark: three arcs fanning up from an emitter dot.
 *
 * The geometry is the `wifi` field from `dither/fields.ts` transcribed to a 16px box — emitter at
 * y = 0.79 of the square, arcs at 0.21/0.40/0.593 of its width, a 45° cone — so the mark and the
 * animated hero read as the same symbol. Stroke rather than the canvas dither because a
 * ResizeObserver and an animation loop per page chrome buy nothing at 16px, where the dither
 * resolves to almost no lit pixels anyway.
 */
export function WifiMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      aria-hidden
      focusable="false"
      // Mono type sits high in its line box, so a glyph centred on the box reads low against the
      // wordmark's cap height. Half a pixel puts it back on the cap band.
      className={`-translate-y-[0.5px] ${className ?? ""}`}
    >
      <path d="M1.35 5.75A9.4 9.4 0 0 1 14.65 5.75" strokeWidth="1.35" />
      <path d="M3.47 7.87A6.4 6.4 0 0 1 12.53 7.87" strokeWidth="1.35" />
      <path d="M5.6 10A3.4 3.4 0 0 1 10.4 10" strokeWidth="1.35" />
      <path d="M8 12.4h0.01" strokeWidth="1.9" />
    </svg>
  );
}
