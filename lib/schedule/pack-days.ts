/**
 * Packing days — pure helpers (framework-free, unit-tested).
 *
 * A pack day is a crew-only appointment (appt_type 'pack') on the SAME lead as
 * its removal, usually the day before. Rules:
 *  - Capacity: a pack demands 0 vans and max(1, assigned crew) people — the
 *    demand grows as you allocate, but a pack on the diary always consumes at
 *    least one person (someone has to go).
 *  - Reschedule: when the removal's move DAY changes, the lead's scheduled
 *    pack days shift by the same number of days, so "the day before" stays
 *    the day before (and any custom offset is preserved).
 *  - Cancel: cancelBookingAction already cancels every scheduled appointment
 *    on the lead, so packs need no special handling there.
 */

import { ukInstant, ukParts } from "@/lib/uk-time";

/** Whole UK calendar days between two yyyy-mm-dd days (negative = backwards). */
export function dayDelta(fromDay: string, toDay: string): number {
  return Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / 86_400_000);
}

/** Shift an instant by whole UK calendar days, KEEPING its UK wall-clock time —
 *  a 09:00 pack stays a 09:00 pack across a DST boundary (raw ms maths would
 *  drift it an hour). */
export function shiftIsoByUkDays(iso: string, days: number): string {
  const p = ukParts(new Date(iso));
  return ukInstant(p.year, p.month, p.day + days, p.hour, p.minute).toISOString();
}

/** A pack's capacity demand: no vans required, at least one person, and the
 *  demand follows the allocation once crew are actually assigned. */
export function packRequirement(assignedCrew: number): { vans: number; men: number } {
  return { vans: 0, men: Math.max(1, assignedCrew) };
}

/** Default pack date for a removal starting on this UK day: the day before. */
export function defaultPackDay(moveDay: string): string {
  const d = new Date(`${moveDay}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
