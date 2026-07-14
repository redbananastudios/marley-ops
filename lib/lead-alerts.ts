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
