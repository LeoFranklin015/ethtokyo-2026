import type { ReactNode } from "react";

/** A bordered plate. The whole UI is plates on paper — no shadows, no gradients. */
export function Panel({
  children,
  className = "",
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "section" | "article" | "aside";
}) {
  return (
    <Tag className={`border border-rule bg-paper-raise rounded-sharp ${className}`}>{children}</Tag>
  );
}

export function PanelHeader({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-rule px-4 py-3">
      <h2 className="label">{children}</h2>
      {right}
    </div>
  );
}
