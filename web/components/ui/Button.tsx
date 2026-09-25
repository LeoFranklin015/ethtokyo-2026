import type { ComponentPropsWithoutRef } from "react";
import Link from "next/link";

type Variant = "solid" | "outline" | "ghost";

const base =
  "inline-flex items-center justify-center gap-2 rounded-full border px-5 h-11 " +
  "font-mono text-xs uppercase tracking-[0.12em] transition-colors " +
  "disabled:opacity-40 disabled:pointer-events-none";

const variants: Record<Variant, string> = {
  solid: "border-ink bg-ink text-paper hover:bg-ink-80 hover:border-ink-80",
  outline: "border-ink/35 text-ink hover:border-ink hover:bg-ink/5",
  ghost: "border-transparent text-ink-muted hover:text-ink hover:bg-ink/5",
};

export function Button({
  variant = "outline",
  className = "",
  ...props
}: ComponentPropsWithoutRef<"button"> & { variant?: Variant }) {
  return <button className={`${base} ${variants[variant]} ${className}`} {...props} />;
}

export function ButtonLink({
  variant = "outline",
  className = "",
  href,
  ...props
}: ComponentPropsWithoutRef<typeof Link> & { variant?: Variant }) {
  return <Link href={href} className={`${base} ${variants[variant]} ${className}`} {...props} />;
}
