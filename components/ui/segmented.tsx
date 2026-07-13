import { cn } from "@/lib/utils";

/**
 * One tab/filter vocabulary for the whole panel.
 *
 * Before this, every page hand-rolled its own switcher and every active state
 * was red (red-tint or solid) — so "red, rare and decisive" (the brand rule)
 * was diluted into a background hum on every list page. These helpers give two
 * calm, neutral affordances; red stays reserved for primary CTAs and the
 * sidebar's active marker.
 *
 *   segmented — switch the view/format/range (iOS-style track: a muted rail
 *               with a raised white active pill). One option is always active.
 *   filterChip — pick a count-filter (rounded pill with a neutral count badge).
 *
 * (Lead-detail keeps the shared Radix underline `Tabs` — a distinct
 *  "sub-navigation within a record" affordance.)
 */

/** Track that wraps a row of `segmentedItemClass` items. */
export const segmentedTrackClass = "inline-flex items-center gap-0.5 rounded-lg bg-muted p-0.5";

/** A single segmented option (Link or button). `active` raises it to a white pill. */
export function segmentedItemClass(active: boolean) {
  return cn(
    "focus-ring inline-flex min-h-8 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors",
    active ? "bg-card text-foreground shadow-sm" : "text-mist-500 hover:text-foreground",
  );
}

/** Neutral count badge for inside a segmented item (e.g. "Staff 3"). */
export function segmentedCountClass(active: boolean) {
  return cn("tabular rounded-pill px-1.5 text-xs", active ? "bg-muted text-mist-500" : "bg-black/5 text-mist-400");
}

/** A rounded filter chip with a live count. `active` fills it with a calm grey. */
export function filterChipClass(active: boolean) {
  return cn(
    "focus-ring inline-flex items-center gap-1.5 rounded-pill border px-3 py-1.5 text-sm font-medium transition-colors",
    active ? "border-mist-300 bg-secondary text-foreground" : "border-border bg-card text-mist-500 hover:bg-muted",
  );
}

/** Neutral count badge for inside a filter chip. */
export function filterChipCountClass(active: boolean) {
  return cn("tabular rounded-pill px-1.5 text-xs", active ? "bg-black/[0.06] text-mist-500" : "bg-muted text-mist-400");
}
