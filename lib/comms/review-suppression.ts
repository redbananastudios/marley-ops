/**
 * Pure decision helper for the post-move review-request suppression
 * (Peter, 2026-07-14). Kept dependency-free so both the server sign-off path
 * and the unit tests can use it without pulling in comms/Supabase modules.
 *
 * The asymmetry is deliberate: a missed review ask is cheap, asking an unhappy
 * customer isn't — so any non-empty exceptions note at completion sign-off
 * auto-switches the review email off (reversible via the office toggle).
 */

/** Does the crew's exceptions note at completion sign-off warrant auto-switching
 *  off the review request? Non-empty after trimming whitespace = yes. */
export function exceptionsWarrantReviewSuppression(exceptions: string | null | undefined): boolean {
  return typeof exceptions === "string" && exceptions.trim().length > 0;
}
