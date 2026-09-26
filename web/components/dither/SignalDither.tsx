"use client";

import { useAnimationFrame, useMotionValue, useReducedMotion, useSpring } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";
import { BAYER_8, BAYER_SIZE } from "./bayer";
import { FIELDS, FITTED, RESTING_PHASE, type Motif } from "./fields";

type Props = {
  motif?: Motif;
  /** Edge length of one dithered pixel, in CSS px. Larger reads chunkier. */
  cell?: number;
  /** Seconds for one full loop of the motif. */
  period?: number;
  /** Ink alpha, 0-1. Ambient textures sit low; the hero runs at full strength. */
  intensity?: number;
  /** Hover accelerates the loop. Off for ambient decoration. */
  interactive?: boolean;
  className?: string;
  /** Announced to assistive tech; the canvas itself is decorative. */
  label?: string;
};

/** Clamped so an exotic ratio cannot multiply the canvas past what it buys. */
function readDpr() {
  if (typeof window === "undefined") return 1;
  return Math.min(3, Math.max(1, window.devicePixelRatio || 1));
}

/**
 * Renders a signal field as a 1-bit ordered dither on canvas.
 *
 * Every pixel is compared against its own Bayer threshold, so a continuous
 * field resolves to an even stipple instead of banding. The buffer is rendered
 * at 1/cell scale and upscaled with smoothing off, which is what gives the
 * chunky pixels.
 */
export function SignalDither({
  motif = "wifi",
  cell = 3,
  period = 2.8,
  intensity = 1,
  interactive = false,
  className,
  label,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const bufferRef = useRef<HTMLCanvasElement | null>(null);
  const imageRef = useRef<ImageData | null>(null);
  const inkRef = useRef<[number, number, number]>([109, 115, 146]);
  const phase = useRef(0);
  const visible = useRef(true);

  const [size, setSize] = useState({ width: 0, height: 0 });
  const [dpr, setDpr] = useState(readDpr);
  const reduceMotion = useReducedMotion();

  const boostTarget = useMotionValue(0);
  const boost = useSpring(boostTarget, { stiffness: 90, damping: 20 });

  // The ratio changes under browser zoom and when the window is dragged to
  // another screen; a query matching the current one is the only event we get
  // for it, so it has to be rebuilt each time the ratio moves.
  useEffect(() => {
    const query = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    const read = () => setDpr(readDpr());
    query.addEventListener("change", read);
    return () => query.removeEventListener("change", read);
  }, [dpr]);

  // Track the box, and stop painting entirely while scrolled out of view.
  useEffect(() => {
    const el = canvasRef.current?.parentElement;
    if (!el) return;
    const resize = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ width: Math.round(width), height: Math.round(height) });
    });
    const intersect = new IntersectionObserver(([entry]) => {
      visible.current = entry.isIntersecting;
    });
    resize.observe(el);
    intersect.observe(el);
    return () => {
      resize.disconnect();
      intersect.disconnect();
    };
  }, []);

  // Read the ink colour once per theme rather than once per frame: calling
  // getComputedStyle inside the animation loop forces a style flush at 60Hz.
  useEffect(() => {
    const readInk = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const parsed = getComputedStyle(canvas).color.match(/\d+/g)?.map(Number);
      if (parsed && parsed.length >= 3) inkRef.current = [parsed[0], parsed[1], parsed[2]];
    };
    readInk();
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    scheme.addEventListener("change", readInk);
    return () => scheme.removeEventListener("change", readInk);
  }, [size]);

  const paint = useCallback(
    (t: number) => {
      const canvas = canvasRef.current;
      const { width, height } = size;
      if (!canvas || width === 0 || height === 0) return;

      const lowW = Math.max(1, Math.ceil(width / cell));
      const lowH = Math.max(1, Math.ceil(height / cell));

      let buffer = bufferRef.current;
      if (!buffer) buffer = bufferRef.current = document.createElement("canvas");
      const bufferCtx = buffer.getContext("2d");
      const ctx = canvas.getContext("2d");
      if (!bufferCtx || !ctx) return;

      if (buffer.width !== lowW || buffer.height !== lowH) {
        buffer.width = lowW;
        buffer.height = lowH;
        imageRef.current = null;
      }
      // Allocate the pixel buffer once and mutate it, not once per frame.
      const image = (imageRef.current ??= bufferCtx.createImageData(lowW, lowH));
      const { data } = image;
      data.fill(0);

      const field = FIELDS[motif];
      const [r, g, b] = inkRef.current;
      const alpha = Math.round(Math.min(1, Math.max(0, intensity)) * 255);

      // A fitted motif is sampled over the largest centred square of the box,
      // so it keeps its aspect ratio and is never cropped; the rest of the box
      // falls outside the unit square, where every field returns 0. Sampling at
      // pixel centres keeps the mark from drifting half a cell off axis.
      const fit = FITTED[motif];
      const spanX = fit ? Math.min(lowW, lowH) : lowW;
      const spanY = fit ? Math.min(lowW, lowH) : lowH;
      const originX = (lowW - spanX) / 2;
      const originY = (lowH - spanY) / 2;

      for (let y = 0; y < lowH; y++) {
        const ny = (y + 0.5 - originY) / spanY;
        const bayerRow = (y % BAYER_SIZE) * BAYER_SIZE;
        for (let x = 0; x < lowW; x++) {
          if (field((x + 0.5 - originX) / spanX, ny, t) > BAYER_8[bayerRow + (x % BAYER_SIZE)]) {
            const i = (y * lowW + x) * 4;
            data[i] = r;
            data[i + 1] = g;
            data[i + 2] = b;
            data[i + 3] = alpha;
          }
        }
      }

      bufferCtx.putImageData(image, 0, 0);

      // The backing store is in device pixels so the upscale lands on the
      // physical grid: on a HiDPI screen a 1:1 canvas would be resampled by the
      // browser and the hard cell edges would go soft.
      const deviceW = Math.round(width * dpr);
      const deviceH = Math.round(height * dpr);
      if (canvas.width !== deviceW || canvas.height !== deviceH) {
        canvas.width = deviceW;
        canvas.height = deviceH;
      }
      ctx.clearRect(0, 0, deviceW, deviceH);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(buffer, 0, 0, lowW, lowH, 0, 0, lowW * cell * dpr, lowH * cell * dpr);
    },
    [cell, dpr, intensity, motif, size],
  );

  useAnimationFrame((_, delta) => {
    if (reduceMotion || !visible.current) return;
    const speed = (1 + (interactive ? boost.get() * 0.85 : 0)) / period;
    phase.current = (phase.current + (delta / 1000) * speed) % 1;
    paint(phase.current);
  });

  // Reduced motion holds a legible frame rather than showing nothing.
  useEffect(() => {
    paint(reduceMotion ? RESTING_PHASE[motif] : phase.current);
  }, [paint, reduceMotion, motif]);

  return (
    <div
      className={className}
      onPointerEnter={interactive ? () => boostTarget.set(1) : undefined}
      onPointerLeave={interactive ? () => boostTarget.set(0) : undefined}
    >
      <canvas ref={canvasRef} aria-hidden className="block h-full w-full text-dither" />
      {label ? <span className="sr-only">{label}</span> : null}
    </div>
  );
}
