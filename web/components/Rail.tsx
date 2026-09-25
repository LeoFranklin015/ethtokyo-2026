"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

/**
 * A horizontal, snap-scrolling rail.
 *
 * Built on native overflow scrolling rather than a transform carousel: the
 * container is focusable, so arrow keys, Page keys, trackpads, touch and
 * screen-reader scrolling all work without bespoke handling. The buttons are
 * an affordance on top, not the only way through.
 */
export function Rail({
  label,
  children,
  className = "",
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(false);
  const [overflows, setOverflows] = useState(false);

  const sync = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setOverflows(max > 4);
    setAtStart(el.scrollLeft <= 4);
    setAtEnd(el.scrollLeft >= max - 4);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    for (const child of Array.from(el.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [sync]);

  const nudge = (direction: 1 | -1) => {
    const el = ref.current;
    if (!el) return;
    const first = el.firstElementChild as HTMLElement | null;
    const step = first ? first.offsetWidth + 16 : el.clientWidth * 0.8;
    el.scrollBy({ left: step * direction, behavior: "smooth" });
  };

  return (
    <div className={className}>
      <div className="mb-3 flex items-center justify-between gap-4">
        <h2 className="label">{label}</h2>
        {overflows ? (
          <div className="flex items-center gap-1">
            <RailButton
              direction="previous"
              disabled={atStart}
              onClick={() => nudge(-1)}
            />
            <RailButton direction="next" disabled={atEnd} onClick={() => nudge(1)} />
          </div>
        ) : null}
      </div>

      <div
        ref={ref}
        onScroll={sync}
        tabIndex={0}
        role="region"
        aria-label={label}
        className="rail flex snap-x snap-mandatory gap-4 overflow-x-auto scroll-smooth pb-1"
      >
        {children}
      </div>
    </div>
  );
}

function RailButton({
  direction,
  disabled,
  onClick,
}: {
  direction: "previous" | "next";
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={`Scroll to ${direction} items`}
      className="grid size-7 place-items-center rounded-full border border-rule text-ink-55 transition-colors hover:border-ink hover:text-ink disabled:pointer-events-none disabled:opacity-30"
    >
      <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden fill="none">
        <path
          d={direction === "next" ? "M6 3l5 5-5 5" : "M10 3L5 8l5 5"}
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="square"
        />
      </svg>
    </button>
  );
}
