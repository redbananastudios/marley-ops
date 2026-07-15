import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Shared quote status pill + header meta chips.
 *
 * ONE source of truth for the status palette so the quote header and the
 * quotes LIST read identically (they used to drift: the list showed a red-tint
 * "Sent" pill while the header showed a blue one). Everything that surfaces a
 * quote's status renders `QuoteStatusPill`.
 */

const QUOTE_STATUS_PILL: Record<string, { label: string; className: string }> = {
  draft: { label: "Draft", className: "bg-mist-100 text-charcoal" },
  sent: { label: "Sent", className: "border border-mm-red/45 bg-card text-mm-red-deep" },
  accepted: { label: "Accepted", className: "bg-success-bg text-success" },
  rejected: { label: "Rejected", className: "bg-mist-50 text-mist-400" },
  superseded: { label: "Superseded", className: "bg-mist-50 text-mist-400" },
};

export function QuoteStatusPill({ status, className }: { status: string; className?: string }) {
  const s = QUOTE_STATUS_PILL[status] ?? { label: status, className: "bg-mist-100 text-charcoal" };
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-pill px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide",
        s.className,
        className,
      )}
    >
      {s.label}
    </span>
  );
}

const META_TONE: Record<string, string> = {
  neutral: "bg-mist-100 text-mist-500",
  success: "bg-success-bg text-success",
  warn: "bg-warn-bg text-warn",
};

/**
 * A muted, informational chip for the header meta row — "Emailed ×2",
 * "Agreed £1,200", deposit status. Deliberately quiet (never a shouting green
 * uppercase badge); it sits next to the eyebrow, not in the action row.
 */
export function QuoteMetaChip({
  icon: Icon,
  tone = "neutral",
  className,
  children,
}: {
  icon?: LucideIcon;
  tone?: "neutral" | "success" | "warn";
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-pill px-2 py-0.5 text-[11px] font-medium",
        META_TONE[tone],
        className,
      )}
    >
      {Icon ? <Icon className="size-3" strokeWidth={2} aria-hidden /> : null}
      {children}
    </span>
  );
}
