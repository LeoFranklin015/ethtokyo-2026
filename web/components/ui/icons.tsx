/**
 * Drawn icons, at one stroke weight.
 *
 * 16px box, 1.35 stroke, round caps — the same construction as `WifiMark`, so a plus beside a
 * label and the mark beside the wordmark carry identical weight. Anything that needs an icon
 * gets one from here rather than a unicode glyph, which never matches the type around it and
 * changes shape between platforms.
 */

function Icon({ children, size = 16 }: { children: React.ReactNode; size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      aria-hidden
      focusable="false"
      className="shrink-0"
    >
      {children}
    </svg>
  );
}

export function PlusIcon({ size }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="M8 3.25v9.5M3.25 8h9.5" />
    </Icon>
  );
}

export function ArrowRightIcon({ size }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="M2.75 8h10.5M9 3.75 13.25 8 9 12.25" strokeLinejoin="round" />
    </Icon>
  );
}
