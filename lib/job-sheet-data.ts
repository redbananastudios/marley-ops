/**
 * Job-sheet data assembly — pure mapping from the appointment + lead + accepted
 * quote + assignments into JobSheetData (rendered by lib/job-sheet-docdef.ts).
 * Kept separate from the server action so tests can walk real shapes.
 */

import { apptWindow, type ApptLite } from "@/lib/job-board";
import { ukCalendarDate } from "@/lib/uk-time";
import { buildOpItems, normalizeQuoteValues, type QuoteFormValues } from "@/lib/quote/form-types";
import type { JobSheetAddress, JobSheetData } from "@/lib/job-sheet-docdef";

export interface SheetLead {
  name: string | null;
  phone: string | null;
  from_address: string | null;
  from_postcode: string | null;
  to_address: string | null;
  to_postcode: string | null;
  notes: string | null;
}

export interface SheetQuote {
  quote_ref: string;
  moving_date: string | null;
  state_blob: unknown;
}

/** "2 Luton Vans + 1 × 7.5t + 1 Transit" from the wizard shape. */
export function vehicleLabelOf(v: QuoteFormValues): string {
  const parts: string[] = [];
  if (v.vehicle === "transit") parts.push("1 Transit Van");
  else {
    const n = Number(v.vehicle[0]) || 1;
    parts.push(`${n} Luton Van${n === 1 ? "" : "s"}`);
  }
  if (v.sevenFiveT > 0) parts.push(`${v.sevenFiveT} × 7.5t Lorry`);
  if (v.transitVans > 0) parts.push(`${v.transitVans} Transit Van${v.transitVans === 1 ? "" : "s"}`);
  return parts.join(" + ");
}

/** "Flat · 2nd floor · no lift · ~25m carry" — the one-line access read the
 *  diary job summary shows per end. Lift only matters off the ground floor. */
export function accessLine(a: JobSheetAddress): string {
  const parts: string[] = [];
  if (a.propertyType) parts.push(a.propertyType.charAt(0).toUpperCase() + a.propertyType.slice(1));
  if (a.floor && a.floor !== "ground") {
    parts.push(`${a.floor} floor`);
    parts.push(a.lift === "yes" ? "lift" : "no lift");
  } else if (a.propertyType) {
    parts.push("ground floor");
  }
  if (a.accessM > 0) parts.push(`~${a.accessM}m carry`);
  return parts.join(" · ");
}

const PACK_LABELS: Record<string, string> = {
  owner: "Owner packs",
  fragile: "Fragile-only pack",
  full: "Full pack service",
};

function sideAddress(
  fallbackAddress: string | null,
  fallbackPostcode: string | null,
  q: QuoteFormValues | null,
  side: "collect" | "dest",
): JobSheetAddress {
  const addr = q ? (side === "collect" ? q.job.collectAddr : q.job.destAddr) : "";
  const access = q ? q[side] : null;
  const postcodeFromQuote = q
    ? (side === "collect" ? q.job.collectAddress?.postcode : q.job.destAddress?.postcode) ?? ""
    : "";
  return {
    address: (addr || fallbackAddress || "").trim(),
    postcode: (postcodeFromQuote || fallbackPostcode || "").trim().toUpperCase(),
    propertyType: access?.type ?? "",
    floor: access?.floor ?? "ground",
    lift: access?.lift ?? "no",
    accessM: Number(access?.accessM) || 0,
  };
}

export function assembleJobSheetData(
  appt: ApptLite & { title: string | null },
  lead: SheetLead | null,
  quote: SheetQuote | null,
  crew: string[],
  vehicles: string[],
): JobSheetData {
  const q = quote ? normalizeQuoteValues(quote.state_blob) : null;
  // The appointment's own starts_at is the LIVE diary slot — the thing the office
  // moves when a date changes. quote.moving_date is a snapshot taken at quoting
  // time and goes stale independently (a reschedule that rolled only the
  // appointment, a legacy import whose date was firmed up on the appointment
  // row). Preferring the quote meant this view, the Job Sheet PDF and the crew
  // day-sheet could all name a different day from the /my-jobs list, which keys
  // purely on starts_at — i.e. tell crew the wrong day for their own job.
  // UK-local to match that list exactly; a UTC slice disagrees with it either
  // side of midnight through BST.
  const moveDate = ukCalendarDate(appt.starts_at) ?? quote?.moving_date ?? null;
  return {
    quoteRef: quote?.quote_ref ?? null,
    customerName: lead?.name || q?.customer.name || appt.title || "Customer",
    customerPhone: lead?.phone || q?.customer.phone || null,
    moveDate,
    timeWindow: apptWindow(appt),
    days: q ? Number(q.job.days) || 1 : 1,
    from: sideAddress(lead?.from_address ?? null, lead?.from_postcode ?? null, q, "collect"),
    to: sideAddress(lead?.to_address ?? null, lead?.to_postcode ?? null, q, "dest"),
    vehicleLabel: q ? vehicleLabelOf(q) : "",
    // No quote → no packing info. Never a placeholder string: surfaces render
    // this label wherever it lands (the /my-jobs Vehicles card, the day sheet),
    // and "See quote" points crew at a quote that does not exist.
    packingLabel: q ? (PACK_LABELS[q.packing] ?? q.packing) : "",
    crew,
    vehicles,
    items: q ? buildOpItems(q.items) : [],
    accessNotes: q?.survey.accessNotes?.trim() ?? "",
    largeItemsNotes: q?.survey.largeItemsNotes?.trim() ?? "",
    jobNotes: (q?.review.quoteNotes || lead?.notes || "").trim(),
    // Quote notes WITHOUT the lead fallback jobNotes carries — surfaces that
    // already show the lead's enquiry notes separately (the diary job summary)
    // must not repeat them under a "quote" label.
    quoteNotes: q?.review.quoteNotes?.trim() ?? "",
  };
}
