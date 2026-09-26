"use client";

import { useId, useMemo, useState } from "react";
import type { Sample } from "@/lib/data";

/**
 * Branch throughput over time — one series, so no legend: the panel title
 * names it. Ships the hover layer an SVG chart owes the reader (crosshair +
 * tooltip), keyboard-drivable, with a screen-reader table behind it.
 *
 * The area is filled with the same ordered-dither stipple used elsewhere, via
 * an SVG pattern, so magnitude reads as texture rather than a colour wash.
 */

const W = 960;
const H = 232;
const PAD = { top: 18, right: 16, bottom: 26, left: 48 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

function niceCeil(value: number): number {
  const step = 10 ** Math.floor(Math.log10(value)) / 2;
  return Math.ceil(value / step) * step;
}

export function ThroughputChart({ data }: { data: Sample[] }) {
  const patternId = useId();
  const [active, setActive] = useState<number | null>(null);

  const { points, areaPath, linePath, ticks, peakIndex } = useMemo(() => {
    // Scaled to the data alone. It used to be floored at a hardcoded "provisioned" capacity,
    // so real traffic was drawn against an invented ceiling.
    const max = niceCeil(Math.max(1, ...data.map((d) => d.mbps)) * 1.05);
    const x = (i: number) => PAD.left + (i / (data.length - 1)) * PLOT_W;
    const y = (v: number) => PAD.top + PLOT_H - (v / max) * PLOT_H;

    const points = data.map((d, i) => ({ ...d, x: x(i), y: y(d.mbps) }));
    const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`);

    return {
      points,
      linePath: line.join(" "),
      areaPath: `${line.join(" ")} L${x(data.length - 1).toFixed(1)} ${(PAD.top + PLOT_H).toFixed(1)} L${PAD.left} ${(PAD.top + PLOT_H).toFixed(1)} Z`,
      ticks: [0, 0.5, 1].map((f) => ({ value: max * f, y: y(max * f) })),
      peakIndex: points.reduce((best, p, i) => (p.mbps > points[best].mbps ? i : best), 0),
    };
  }, [data]);

  const cursor = active === null ? null : points[active];

  // Two points is the minimum a line can be drawn from; below that every coordinate divides by
  // zero and `points[peakIndex]` is undefined. The caller already checks, but this is cheap.
  const tooThin = data.length < 2;

  function onMove(event: React.PointerEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = ((event.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((ratio - PAD.left) / PLOT_W) * (data.length - 1));
    setActive(Math.min(data.length - 1, Math.max(0, i)));
  }

  function onKey(event: React.KeyboardEvent<SVGSVGElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const step = event.key === "ArrowRight" ? 1 : -1;
    setActive((prev) => {
      const next = (prev ?? peakIndex) + step;
      return Math.min(data.length - 1, Math.max(0, next));
    });
  }

  if (tooThin) {
    return (
      <p className="px-2 py-10 text-center font-mono text-xs text-ink-muted">
        Not enough samples yet.
      </p>
    );
  }

  return (
    <figure className="m-0">
      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="block h-[232px] w-full touch-none"
          role="img"
          tabIndex={0}
          aria-label={`API proxy throughput over six hours, peaking at ${points[peakIndex].mbps} megabits per second`}
          onPointerMove={onMove}
          onPointerLeave={() => setActive(null)}
          onFocus={() => setActive(peakIndex)}
          onBlur={() => setActive(null)}
          onKeyDown={onKey}
        >
          <defs>
            <pattern id={patternId} width="4" height="4" patternUnits="userSpaceOnUse">
              <rect width="4" height="4" fill="none" />
              <rect width="1" height="1" x="0" y="0" fill="var(--dither)" opacity="0.9" />
              <rect width="1" height="1" x="2" y="2" fill="var(--dither)" opacity="0.9" />
            </pattern>
          </defs>

          {/* Recessive grid */}
          {ticks.map((tick) => (
            <g key={tick.value}>
              <line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={tick.y}
                y2={tick.y}
                stroke="var(--rule)"
                strokeWidth="1"
              />
              <text
                x={PAD.left - 10}
                y={tick.y + 3.5}
                textAnchor="end"
                className="fill-[var(--ink-muted)] font-mono text-[10px] tabular-nums"
              >
                {Math.round(tick.value)}
              </text>
            </g>
          ))}

          <path d={areaPath} fill={`url(#${patternId})`} />
          <path
            d={linePath}
            fill="none"
            stroke="var(--ink)"
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />

          {/* Time axis: first, middle and last only */}
          {[0, Math.floor(data.length / 2), data.length - 1].map((i) => (
            <text
              key={i}
              x={points[i].x}
              y={H - 8}
              textAnchor={i === 0 ? "start" : i === data.length - 1 ? "end" : "middle"}
              className="fill-[var(--ink-muted)] font-mono text-[10px] tabular-nums"
            >
              {data[i].t}
            </text>
          ))}

          {cursor ? (
            <g>
              <line
                x1={cursor.x}
                x2={cursor.x}
                y1={PAD.top}
                y2={PAD.top + PLOT_H}
                stroke="var(--ink-faint)"
                strokeWidth="1"
              />
              <circle cx={cursor.x} cy={cursor.y} r="4.5" fill="var(--paper)" />
              <circle cx={cursor.x} cy={cursor.y} r="4.5" fill="none" stroke="var(--ink)" strokeWidth="2" />
            </g>
          ) : null}
        </svg>

        {cursor ? (
          <div
            role="status"
            className="pointer-events-none absolute top-2 rounded-sharp border border-rule bg-paper px-2.5 py-1.5"
            style={{
              left: `${(cursor.x / W) * 100}%`,
              transform: `translateX(${cursor.x > W * 0.7 ? "-100%" : "0"})`,
            }}
          >
            <p className="font-mono text-[0.6875rem] tabular-nums text-ink">
              {cursor.mbps} Mbps
            </p>
            <p className="font-mono text-[0.6875rem] tabular-nums text-ink-muted">
              {cursor.t} · {cursor.active_ips} sending
            </p>
          </div>
        ) : null}
      </div>

      {/* Table view: identity and values never depend on the mark alone. */}
      <figcaption className="sr-only">
        <table>
          <caption>API proxy throughput in Mbps by time</caption>
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Mbps</th>
              <th scope="col">Addresses sending</th>
            </tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.t}>
                <th scope="row">{d.t}</th>
                <td>{d.mbps}</td>
                <td>{d.active_ips}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </figcaption>
    </figure>
  );
}
