import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Shared building blocks for /manual. Kept deliberately plain (no new deps,
 * matches the white-card / hairline-border / charcoal-text look used across
 * the rest of the app — see components/ui/card.tsx and app/globals.css).
 */

/** Top-level h2 section. Every section gets an id so the table of contents
 *  (and any deep link) can jump straight to it. */
export function Section({
  id,
  title,
  eyebrow,
  children,
}: {
  id: string;
  title: string;
  eyebrow?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24 border-t border-border pt-10 first:border-t-0 first:pt-0">
      {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
      <h2 className="font-display text-2xl font-semibold tracking-[-0.02em] text-foreground">{title}</h2>
      <div className="mt-4 space-y-6">{children}</div>
    </section>
  );
}

/** Sub-topic inside a Section. */
export function SubHeading({ id, title }: { id: string; title: string }) {
  return (
    <h3 id={id} className="scroll-mt-24 font-display text-base font-semibold text-foreground">
      {title}
    </h3>
  );
}

/** A card wrapping one sub-topic's steps/content, so the guide reads as a
 *  stack of short scannable panels rather than one long scroll of prose. */
export function GuideCard({
  id,
  title,
  lead,
  children,
}: {
  id: string;
  title: string;
  lead?: string;
  children: React.ReactNode;
}) {
  return (
    <div id={id ? `${id}-card` : undefined} className="rounded-lg border border-border bg-card p-5">
      <SubHeading id={id} title={title} />
      {lead ? <p className="mt-1 text-sm text-mist-500">{lead}</p> : null}
      <div className="mt-3 space-y-3 text-sm text-foreground">{children}</div>
    </div>
  );
}

/** Numbered steps — the default shape for "how to do X". */
export function Steps({ items }: { items: React.ReactNode[] }) {
  return (
    <ol className="space-y-2">
      {items.map((item, i) => (
        <li key={i} className="flex gap-3 text-sm leading-relaxed text-foreground">
          <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-mm-red text-[11px] font-semibold text-white">
            {i + 1}
          </span>
          <span className="min-w-0">{item}</span>
        </li>
      ))}
    </ol>
  );
}

/** Plain bullet list — for reference-shaped content that isn't sequential. */
export function Bullets({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="space-y-1.5">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2.5 text-sm leading-relaxed text-foreground">
          <span className="mt-2 size-1 shrink-0 rounded-full bg-mist-400" />
          <span className="min-w-0">{item}</span>
        </li>
      ))}
    </ul>
  );
}

/** Red-accented callout for gotchas, warnings, "never do this" lines. */
export function Note({ tone = "warn", children }: { tone?: "warn" | "info"; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "flex gap-2.5 rounded-md border px-3.5 py-2.5 text-sm leading-relaxed",
        tone === "warn" ? "border-warn-border bg-warn-bg text-warn" : "border-border bg-muted text-mist-500",
      )}
    >
      {tone === "warn" ? <AlertTriangle className="mt-0.5 size-4 shrink-0" strokeWidth={1.75} /> : null}
      <span className="min-w-0">{children}</span>
    </div>
  );
}

/** Inline UI-label chip — for referencing a real button/tab name inline in prose. */
export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <span className="mx-0.5 inline-block rounded border border-border bg-muted px-1.5 py-0.5 text-[12px] font-medium text-foreground">
      {children}
    </span>
  );
}

/** Simple responsive data table (horizontal scroll on narrow viewports). */
export function ManualTable({
  columns,
  rows,
}: {
  columns: string[];
  rows: React.ReactNode[][];
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[560px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-border bg-muted">
            {columns.map((c) => (
              <th key={c} className="px-3.5 py-2.5 text-left text-xs font-semibold uppercase tracking-[0.04em] text-mist-500">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className={cn("border-b border-border last:border-0", i % 2 === 1 && "bg-muted/40")}>
              {row.map((cell, j) => (
                <td key={j} className="px-3.5 py-2.5 align-top text-foreground">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
