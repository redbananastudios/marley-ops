/**
 * Web-lead alert helpers (pure — the audible/banner UI lives in
 * components/alerts/new-lead-alert.tsx, the data in app/actions/lead-alerts.ts).
 *
 * The chime rule: a batch of unacknowledged leads chimes for a bounded cycle
 * (10 repeats, ~30s), then goes quiet while the banner persists. A poll that
 * returns the SAME still-unacked leads must not restart the noise; a poll
 * that brings a lead id we have never chimed for restarts the full cycle.
 */

export const ALERT_POLL_MS = 20_000;
export const CHIME_REPEAT_MS = 3_000;
export const CHIME_MAX_REPEATS = 10;
export const CHIMED_STORAGE_KEY = "mm-chimed-web-leads-v1";

/** Parse the device-scoped chime ledger defensively; UUIDs are retained only. */
export function parseChimedLeadIds(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return new Set();
    return new Set(value.filter((id): id is string =>
      typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
    ).slice(-100));
  } catch {
    return new Set();
  }
}

export function serializeChimedLeadIds(ids: ReadonlySet<string>): string {
  return JSON.stringify([...ids].slice(-100));
}

export interface ChimeDecision {
  /** Ids we have now chimed (or are chiming) for. Feed back into the next call. */
  chimed: Set<string>;
  /** True when a fresh 10-repeat chime cycle should start. */
  restart: boolean;
}

/**
 * Decide whether a poll result should (re)start the chime cycle.
 *
 * @param alreadyChimed ids that have had a chime cycle this session
 * @param currentIds    unacked lead ids from the latest poll
 */
export function nextChimeState(
  alreadyChimed: ReadonlySet<string>,
  currentIds: readonly string[],
): ChimeDecision {
  if (currentIds.length === 0) {
    // Everything acknowledged — silence, and forget the batch (uuids never
    // come back unacked, so pruning here just stops the set growing forever).
    return { chimed: new Set(), restart: false };
  }
  const restart = currentIds.some((id) => !alreadyChimed.has(id));
  const chimed = new Set(alreadyChimed);
  for (const id of currentIds) chimed.add(id);
  return { chimed, restart };
}

export interface UnackedWebLead {
  id: string;
  name: string;
  created_at: string;
}

/** A row created this long after it was submitted is an IMPORT, not a live lead. */
export const IMPORT_GAP_MS = 24 * 3600 * 1000;

/**
 * True when an unacked website row looks like a historical IMPORT (the row was
 * created long after the enquiry was submitted) rather than a genuinely fresh
 * lead nobody has acknowledged yet. Mirrors migration 0071's guard exactly: a
 * live-synced lead has created_at ≈ submitted_at, so it stays unacknowledged —
 * and keeps its banner — until a human presses Acknowledge, no matter how many
 * days it sits. Only the created/submitted gap identifies an import.
 */
export function isImportedUnackedRow(
  createdAt: string | null,
  alertSubmittedAt: string | null,
): boolean {
  if (!createdAt || !alertSubmittedAt) return false;
  const created = Date.parse(createdAt);
  const submitted = Date.parse(alertSubmittedAt);
  if (!Number.isFinite(created) || !Number.isFinite(submitted)) return false;
  return created - submitted > IMPORT_GAP_MS;
}
