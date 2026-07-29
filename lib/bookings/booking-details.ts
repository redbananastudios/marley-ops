/**
 * Booking details — pure input shaping for the shared booking-details drawer
 * (design doc docs/schedule-allocation-design.md, D4/D7/D9).
 *
 * The `booking_details` side-table (migration 0080) captures a lead's move
 * window BEFORE anything hits the diary: a free-text approximate window in the
 * customer's own words, a target month for grouping the demand panel, a
 * provisional (guessed) date, and the homeowner/rented date-flex flag. These
 * helpers normalise the drawer's raw form values into DB-ready shapes and are
 * framework-free so they unit-test in isolation.
 */

export const PROPERTY_TYPES = ["homeowner", "rented"] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];

export type Normalised = { ok: true; value: string | null } | { ok: false; error: string };

/** Free-text window ("mid-August") — trimmed, capped at 120 chars, empty → null. */
export function cleanApproxWindow(v: string | null | undefined): string | null {
  const trimmed = (v ?? "").trim().slice(0, 120).trim();
  return trimmed.length ? trimmed : null;
}

/**
 * Target month → first-of-month ISO date (the DB stores a `date` so the demand
 * panel can group/sort). Accepts the HTML month input's "YYYY-MM" and — so a
 * value read back from the DB can be resubmitted unchanged — a full
 * "YYYY-MM-DD". Empty means "no target month"; anything else is invalid.
 */
export function normaliseApproxMonth(v: string | null | undefined): Normalised {
  const raw = (v ?? "").trim();
  if (!raw) return { ok: true, value: null };
  const m = /^(\d{4})-(0[1-9]|1[0-2])(-\d{2})?$/.exec(raw);
  if (!m) return { ok: false, error: "The target month must be a calendar month." };
  return { ok: true, value: `${m[1]}-${m[2]}-01` };
}

/**
 * Provisional date — a guessed specific day that stays OFF the diary (no
 * appointment row) until the 25% confirms it. Must be a real calendar date in
 * YYYY-MM-DD form; empty means "no provisional date yet".
 */
export function normaliseProvisionalDate(
  v: string | null | undefined,
  /** UK "today" (YYYY-MM-DD) — injectable so tests stay pure. */
  today?: string,
): Normalised {
  const raw = (v ?? "").trim();
  if (!raw) return { ok: true, value: null };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return { ok: false, error: "The provisional date must be a full date." };
  }
  // Round-trip through UTC to reject impossible calendar dates (e.g. 30 Feb).
  const d = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) {
    return { ok: false, error: "That provisional date does not exist." };
  }
  // Plausibility bounds (review 2026-07-29): a past date silently vanishes from
  // the demand panel, a typo'd far year pollutes month grouping. Today .. +2y.
  const ukToday = today ?? new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
  if (raw < ukToday) {
    return { ok: false, error: "The provisional date is in the past." };
  }
  const max = new Date(`${ukToday}T00:00:00Z`);
  max.setUTCFullYear(max.getUTCFullYear() + 2);
  if (raw > max.toISOString().slice(0, 10)) {
    return { ok: false, error: "The provisional date is too far ahead (2 years max)." };
  }
  return { ok: true, value: raw };
}

/** Homeowner/rented flag — anything outside the two known values reads as unset. */
export function normalisePropertyType(v: string | null | undefined): PropertyType | null {
  return v === "homeowner" || v === "rented" ? v : null;
}
