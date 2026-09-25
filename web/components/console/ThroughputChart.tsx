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

export function ThroughputChart({ data, cap }: { data: Sample[]; cap: number }) {
  const patternId = useId();
  const [active, setActive] = useState<number | null>(null);

  const { max, points, areaPath, linePath, ticks, peakIndex } = useMemo(() => {
    const max = niceCeil(Math.max(cap, ...data.map((d) => d.mbps)) * 1.05);
    const x = (i: number) => PAD.left + (i / (data.length - 1)) * PLOT_W;
    const y = (v: number) => PAD.top + PLOT_H - (v / max) * PLOT_H;

    const points = data.map((d, i) => ({ ...d, x: x(i), y: y(d.mbps) }));
    const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`);

    return {
      max,
      points,
      linePath: line.join(" "),
      areaPath: `${line.join(" ")} L${x(data.length - 1).toFixed(1)} ${(PAD.top + PLOT_H).toFixed(1)} L${PAD.left} ${(PAD.top + PLOT_H).toFixed(1)} Z`,
      ticks: [0, 0.5, 1].map((f) => ({ value: max * f, y: y(max * f) })),
      peakIndex: points.reduce((best, p, i) => (p.mbps > points[best].mbps ? i : best), 0),
    };
  }, [cap, data]);

  const capY = PAD.top + PLOT_H - (cap / max) * PLOT_H;
  const cursor = active === null ? null : points[active];

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

  return (
    <figure className="m-0">
      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="block h-[232px] w-full touch-none"
          role="img"
          tabIndex={0}
          aria-label={`Branch throughput over six hours, peaking at ${points[peakIndex].mbps} of ${cap} megabits per second provisioned`}
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

          {/* Provisioned ceiling */}
          <line
            x1={PAD.left}
            x2={W - PAD.right}
            y1={capY}
            y2={capY}
            stroke="var(--ink-faint)"
            strokeWidth="1"
            strokeDasharray="3 3"
          />
          <text
            x={W - PAD.right}
            y={capY - 6}
            textAnchor="end"
            className="fill-[var(--ink-muted)] font-mono text-[10px]"
          >
            {cap} provisioned
          </text>

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
              {cursor.t} · {cursor.admitted} admitted
            </p>
          </div>
        ) : null}
      </div>

      {/* Table view: identity and values never depend on the mark alone. */}
      <figcaption className="sr-only">
        <table>
          <caption>Branch throughput in Mbps by time</caption>
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Mbps</th>
              <th scope="col">Admitted</th>
            </tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.t}>
                <th scope="row">{d.t}</th>
                <td>{d.mbps}</td>
                <td>{d.admitted}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </figcaption>
    </figure>
  );
}
