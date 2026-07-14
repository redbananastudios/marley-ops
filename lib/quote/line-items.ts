/**
 * CUSTOMER-facing quote line items — the presentation-layer grouping of a
 * QuoteBreakdown for anything a customer sees (the quote PDF today).
 *
 * Two rules the office/internal renderings do NOT follow (they keep full detail):
 *
 *  1. The vehicle base line(s) — Luton base, 7.5-tonne base, add-on Transit base —
 *     and the admin fee collapse into ONE line, "Your Removal". Van counts and
 *     crew numbers often change before move day, so no customer line names them.
 *  2. No customer label or detail reveals a van count or crew size: floor / access /
 *     congestion details drop the "× N vans" multiplier and the word "van".
 *
 * MONEY IS NEVER RE-COMPUTED HERE. Every amount is copied verbatim from the
 * breakdown; the returned items sum EXACTLY to `b.subtotal` (the admin fee lives
 * inside "Your Removal", it is not hidden). computeQuote() stays the only place
 * money is calculated.
 */

import type { QuoteBreakdown } from "./pricing";
import { MILEAGE_RATE, type PackingKey } from "./constants";

export interface CustomerLineItem {
  /** Bold line label — the ITEM / SERVICES column. */
  label: string;
  /** Muted supporting detail below the label ("" hides the second line). */
  detail: string;
  /** QUANTITY column — never a van/crew count on a customer surface. */
  qty: number | string;
  /** UNIT PRICE column. */
  unit: number;
  /** AMOUNT column — always explicit; the row total, never derived downstream. */
  amount: number;
}

/** Count-free pack-tier names (no van/crew numbers — pack price scales with vans). */
const PACK_LABELS: Record<PackingKey, string> = {
  owner: "Owner Pack",
  fragile: "Fragile Only Pack",
  full: "Full Pack Service",
};

/**
 * Build the customer line items for a quote. Pure; the PDF (and any future
 * customer rendering) call this so the "no counts" grouping can never drift.
 */
export function customerLineItems(b: QuoteBreakdown): CustomerLineItem[] {
  const items: CustomerLineItem[] = [];

  // ── Your Removal — every fleet base line + the admin fee, as one line ──
  // base (Luton) + 7.5t base + add-on Transit base + admin fee. This is the
  // one place fleet detail would otherwise leak, so it is deliberately generic.
  const yourRemoval = b.base + b.addon75Cost + b.transitCost + b.adminFee;
  items.push({
    label: "Your Removal",
    detail: "Team, transport & coordination",
    qty: 1,
    unit: yourRemoval,
    amount: yourRemoval,
  });

  // ── Packing (owner/fragile/full + any 7.5t packing) — pack tier, no counts ──
  const packCost = b.packCost + b.addon75PackCost;
  if (packCost > 0) {
    items.push({
      label: "Packing Service",
      detail: PACK_LABELS[b.packing],
      qty: 1,
      unit: packCost,
      amount: packCost,
    });
  }

  // ── Additional days — time, not fleet; keeps its own line ──
  if ((b.extraDaysCost ?? 0) > 0) {
    const extraDays = Math.max(1, (b.days ?? 1) - 1);
    items.push({
      label: "Additional Days",
      detail: `${extraDays} day${extraDays > 1 ? "s" : ""} beyond the first`,
      qty: extraDays,
      unit: (b.extraDaysCost ?? 0) / extraDays,
      amount: b.extraDaysCost ?? 0,
    });
  }

  // ── Mileage ──
  if (b.mileageCost !== null) {
    items.push({
      label: "Mileage",
      detail: "Total mileage at £2.00/mi, rounded to the nearest £",
      qty: (b.totalMiles as number).toFixed(1) + " mi",
      unit: MILEAGE_RATE,
      amount: b.mileageCost,
    });
  }

  // ── Access — distance from the vehicle to the door (no "van", no count) ──
  if (b.collectAccessCost > 0) {
    items.push({
      label: "Collection Access",
      detail: "Distance from vehicle to door",
      qty: 1,
      unit: b.collectAccessCost,
      amount: b.collectAccessCost,
    });
  }
  if (b.destAccessCost > 0) {
    items.push({
      label: "Destination Access",
      detail: "Distance from vehicle to door",
      qty: 1,
      unit: b.destAccessCost,
      amount: b.destAccessCost,
    });
  }

  // ── Floor charges — upper-floor access; the "× N vans" multiplier is dropped ──
  if (b.collectFloorCost > 0) {
    items.push({
      label: "Collection Floor Charge",
      detail: "Stairs / upper-floor access",
      qty: 1,
      unit: b.collectFloorCost,
      amount: b.collectFloorCost,
    });
  }
  if (b.destFloorCost > 0) {
    items.push({
      label: "Destination Floor Charge",
      detail: "Stairs / upper-floor access",
      qty: 1,
      unit: b.destFloorCost,
      amount: b.destFloorCost,
    });
  }

  // ── Congestion — zone charge; per-van pricing not named ──
  if (b.congestion > 0) {
    items.push({
      label: "Congestion Charge",
      detail: "Low-emission / congestion zone",
      qty: 1,
      unit: b.congestion,
      amount: b.congestion,
    });
  }

  // ── Straight pass-through miscellaneous costs ──
  if (b.tolls > 0) items.push({ label: "Toll Charges", detail: "", qty: 1, unit: b.tolls, amount: b.tolls });
  if (b.parking > 0) items.push({ label: "Parking Permit", detail: "", qty: 1, unit: b.parking, amount: b.parking });

  return items;
}
