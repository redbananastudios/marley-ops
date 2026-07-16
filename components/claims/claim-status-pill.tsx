import { CLAIM_STATUS_LABEL, type ClaimStatus } from "@/lib/claims";
import { cn } from "@/lib/utils";

/** Semantic status pill (colour pass rules: danger/warn/red-outline/success/muted). */
const PILL: Record<ClaimStatus, string> = {
  open: "border border-danger-border bg-danger-bg text-danger",
  assessing: "border border-warn-border bg-warn-bg text-warn",
  offer_made: "border border-mm-red/45 bg-card text-mm-red-deep",
  settled: "border border-success-border bg-success-bg text-success",
  rejected: "bg-muted text-mist-500",
  closed: "bg-muted text-mist-500",
};

export function ClaimStatusPill({ status, className }: { status: ClaimStatus; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-pill px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide",
        PILL[status],
        className,
      )}
    >
      {CLAIM_STATUS_LABEL[status]}
    </span>
  );
}
