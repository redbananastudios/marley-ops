"use client";

/**
 * The Beginning / Middle / End segmented picker for a provisional move window
 * (Peter, 2026-08-14) — one control shared by the Add-lead form, the Edit-lead
 * dialog and the Move Window drawer so the vocabulary can't drift. Clicking
 * the selected tier again clears it (a window is optional).
 */

import { cn } from "@/lib/utils";
import { WINDOW_TIERS, WINDOW_TIER_LABELS, type WindowTier } from "@/lib/bookings/booking-details";

export function WindowTierPicker({
  value,
  onChange,
  idPrefix = "window-tier",
}: {
  /** Current tier or "" for unset. */
  value: string;
  onChange: (next: "" | WindowTier) => void;
  idPrefix?: string;
}): React.JSX.Element {
  return (
    <div className="inline-flex w-fit gap-1 rounded-lg border border-border bg-card p-1" role="group">
      {WINDOW_TIERS.map((tier) => (
        <button
          key={tier}
          id={`${idPrefix}-${tier}`}
          type="button"
          aria-pressed={value === tier}
          onClick={() => onChange(value === tier ? "" : tier)}
          className={cn(
            "focus-ring rounded-md px-3 py-1.5 text-sm font-semibold transition-colors",
            value === tier ? "bg-foreground text-card" : "text-mist-500 hover:text-foreground",
          )}
        >
          {WINDOW_TIER_LABELS[tier]}
        </button>
      ))}
    </div>
  );
}
