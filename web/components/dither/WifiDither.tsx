"use client";

import { useAnimationFrame, useMotionValue, useReducedMotion, useSpring } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";
import { BAYER_8, BAYER_SIZE, gaussian, smoothstep } from "./bayer";

type Props = {
  /** Edge length of one dithered pixel, in CSS px. Larger reads chunkier. */
  cell?: number;
  /** Seconds for one pulse to travel from the emitter to the outer arc. */
  period?: number;
  className?: string;
  /** Announced to assistive tech; the canvas itself is decorative. */
  label?: string;
};

/** Emitter sits low and centred, the way a wifi glyph is drawn. */
const ORIGIN_X = 0.5;
const ORIGIN_Y = 0.9;
const ARC_RADII = [0.3, 0.53, 0.76];
const ARC_SIGMA = 0.035;
const DOT_RADIUS = 0.075;
const CONE = Math.PI / 4; // half-angle of the arc spread

/**
 * Signal strength in [0,1] at a point, for pulse phase `wave`.
 * `wave` sweeps 0 → 1.15 so the pulse fully clears the outer arc.
 *
 * `aspect` (width / height) rescales the horizontal axis so the arcs stay
 * circular in a non-square canvas — without it a wide box yields ellipses.
 */
function field(nx: number, ny: number, wave: number, aspect: number): number {
  const dx = (nx - ORIGIN_X) * aspect;
  const dy = ny - ORIGIN_Y;
  const r = Math.hypot(dx, dy);

  // The emitter dot is always lit, with a soft edge so it dithers cleanly.
  const dot = 1 - smoothstep(DOT_RADIUS * 0.7, DOT_RADIUS, r);
  if (dot > 0.99) return 1;

  // Arcs only exist above the emitter, inside the cone, tapering at the ends.
  if (dy > 0) return dot;
  const angle = Math.atan2(dx, -dy); // 0 straight up, ± toward the sides
  const spread = 1 - smoothstep(CONE * 0.72, CONE, Math.abs(angle));
  if (spread <= 0) return dot;

  let arcs = 0;
  for (const radius of ARC_RADII) {
    arcs = Math.max(arcs, gaussian(r, radius, ARC_SIGMA));
  }

  // A bright ring travels outward through the static arcs.
  const pulse = gaussian(r, wave, 0.13);
  const lit = arcs * spread * (0.42 + 0.72 * pulse);

  return Math.max(dot, Math.min(1, lit));
}

export function WifiDither({
  cell = 3,
  period = 2.8,
  className,
  label = "Animated wifi signal",
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const bufferRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const reduceMotion = useReducedMotion();

  // Hover nudges the pulse along; the spring keeps it from snapping.
  const boostTarget = useMotionValue(0);
  const boost = useSpring(boostTarget, { stiffness: 90, damping: 20 });
  const phase = useRef(0);

  useEffect(() => {
    const el = canvasRef.current?.parentElement;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ width: Math.round(width), height: Math.round(height) });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const paint = useCallback(
    (wave: number) => {
      const canvas = canvasRef.current;
      const { width, height } = size;
      if (!canvas || width === 0 || height === 0) return;

      // Ceil rather than floor so the upscaled buffer always covers the box.
      const lowW = Math.max(1, Math.ceil(width / cell));
      const lowH = Math.max(1, Math.ceil(height / cell));
      const aspect = lowW / lowH;

      let buffer = bufferRef.current;
      if (!buffer) {
        buffer = document.createElement("canvas");
        bufferRef.current = buffer;
      }
      if (buffer.width !== lowW || buffer.height !== lowH) {
        buffer.width = lowW;
        buffer.height = lowH;
      }

      const bufferCtx = buffer.getContext("2d");
      const ctx = canvas.getContext("2d");
      if (!bufferCtx || !ctx) return;

      // Read the ink colour from CSS so the canvas follows the theme.
      const ink = getComputedStyle(canvas).color;
      const image = bufferCtx.createImageData(lowW, lowH);
      const { data } = image;

      const rgb = ink.match(/\d+/g)?.map(Number) ?? [20, 20, 15];
      const [r, g, b] = rgb;

      for (let y = 0; y < lowH; y++) {
        const ny = y / lowH;
        const bayerRow = (y % BAYER_SIZE) * BAYER_SIZE;
        for (let x = 0; x < lowW; x++) {
          const value = field(x / lowW, ny, wave, aspect);
          if (value > BAYER_8[bayerRow + (x % BAYER_SIZE)]) {
            const i = (y * lowW + x) * 4;
            data[i] = r;
            data[i + 1] = g;
            data[i + 2] = b;
            data[i + 3] = 255;
          }
        }
      }

      bufferCtx.putImageData(image, 0, 0);

      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      ctx.clearRect(0, 0, width, height);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(buffer, 0, 0, lowW, lowH, 0, 0, lowW * cell, lowH * cell);
    },
    [cell, size],
  );

  useAnimationFrame((_, delta) => {
    if (reduceMotion) return;
    const speed = (1 + boost.get() * 0.85) / period;
    phase.current = (phase.current + (delta / 1000) * speed) % 1;
    paint(phase.current * 1.15);
  });

  // Reduced motion, resize, and theme changes all need a one-off repaint.
  useEffect(() => {
    paint(reduceMotion ? 0.62 : phase.current * 1.15);
  }, [paint, reduceMotion]);

  return (
    <div
      className={className}
      onPointerEnter={() => boostTarget.set(1)}
      onPointerLeave={() => boostTarget.set(0)}
    >
      <canvas ref={canvasRef} aria-hidden className="block h-full w-full text-ink" />
      <span className="sr-only">{label}</span>
    </div>
  );
}
