/**
 * Go-live sync floor (Peter, 2026-07-21 — the no-backfill cutover decision).
 *
 * `LEAD_SYNC_SINCE` (ISO timestamp env) is a HARD floor on the Sanity lead
 * sync: submissions before it never import, in ANY mode — including the manual
 * "Sync website leads" button. Why structural, not procedural: after the
 * system flush the leads table is empty, so incremental mode has no latest
 * row and would fall back to a FULL historical import on the first dashboard
 * load. The floor turns "we will not backfill" into something the system
 * enforces rather than something a runbook step has to remember.
 */

/** Parse to a valid ISO timestamp or null (garbled env must not silently
 *  disable the floor's comparison — an invalid date compares NaN). */
function validTimestamp(s: string | null | undefined): string | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : s;
}

/** Combine a resolved `since` cutoff with the env floor: whichever is LATER wins. */
export function applySyncFloor(
  since: string | undefined,
  floor: string | null | undefined,
): string | undefined {
  const f = validTimestamp(floor);
  if (!f) return since;
  if (!since) return f;
  return new Date(since) < new Date(f) ? f : since;
}
