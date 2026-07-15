/**
 * Lead ownership — the single source of truth for "whose lead is this".
 *
 * A lead can be attributed to an estimator two ways:
 *   1. explicit    — `leads.estimator_id` is set (a pre-survey manual assignment;
 *                    booking a survey does NOT write this column), OR
 *   2. survey-derived — whoever is assigned the booked survey appointment.
 *
 * Explicit assignment wins: an owner set on the lead stays the owner even if a
 * survey is later booked with someone else. The survey estimator is only the
 * fallback when there is no explicit owner. Returns null when neither is known.
 *
 * Used by BOTH the estimator "My day" cockpit and the /leads "Mine" preset so a
 * lead can't appear in one place and vanish from the other (the pre-survey
 * assigned lead used to show on My day but not under Mine — this unifies them).
 */
export function ownerEstimatorId(
  leadEstimatorId: string | null | undefined,
  surveyEstimatorId: string | null | undefined,
): string | null {
  return leadEstimatorId ?? surveyEstimatorId ?? null;
}

/** Whether `estimatorId` owns the lead under the unified rule. */
export function isOwnedByEstimator(
  estimatorId: string | null | undefined,
  leadEstimatorId: string | null | undefined,
  surveyEstimatorId: string | null | undefined,
): boolean {
  return !!estimatorId && ownerEstimatorId(leadEstimatorId, surveyEstimatorId) === estimatorId;
}
