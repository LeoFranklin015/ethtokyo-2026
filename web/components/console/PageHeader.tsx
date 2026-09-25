import type { ReactNode } from "react";

/** Consistent page chrome inside the console shell. */
export function PageHeader({
  eyebrow,
  title,
  meta,
  actions,
}: {
  eyebrow: string;
  title: string;
  meta?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4 border-b border-rule px-5 py-5 lg:px-8 lg:py-6">
      <div className="min-w-0">
        <p className="label">{eyebrow}</p>
        <h1 className="mt-2 truncate font-mono text-xl tracking-tight text-ink lg:text-2xl">
          {title}
        </h1>
        {meta ? <p className="mt-1.5 text-sm text-ink-muted">{meta}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}
