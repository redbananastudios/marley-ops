/**
 * Whether a lead may be deleted outright.
 *
 * Delete exists to clear DUPLICATES — the same customer enquiring twice, the
 * second one carrying a typo (Danielle, 2026-08-18: two enquiries four minutes
 * apart, the second with `.go.vuk` for `.gov.uk`). It is not an undo for real
 * work. A lead that has been quoted, taken money, been given a slot in the
 * diary, or had the customer sign something is business history: losing it
 * loses the audit trail behind an invoice or a contract, which is exactly what
 * we would need if the job were ever disputed. Those are closed or merged, not
 * deleted.
 *
 * Pure so the rule is testable and identical wherever it is asked — the button
 * hides on the same condition the server refuses on, so the UI can never offer
 * a delete the action would reject.
 */
export interface LeadDeletionFacts {
  quotes: number;
  appointments: number;
  signatures: number;
  cardPayments: number;
  cubicSurveys: number;
  /**
   * Storage lets that deleting THIS lead would leave with no enquiry behind
   * them — not "lets on this lead". See `storageLetsBlockingDelete`; the
   * distinction is the whole of QA-20260820-08.
   */
  orphanedStorageLets: number;
  claims: number;
  jobCompletions: number;
}

export type LeadDeletion =
  | { deletable: true }
  | { deletable: false; reason: string };

/**
 * How many storage lets a lead delete would strand.
 *
 * Storage is CLIENT-scoped, never lead-scoped: `startLetAction` only ever
 * writes `storage_lets.client_id`, and every display surface (`/storage`,
 * `/performance`, `/s/[token]`) reads it that way. The old guard counted by
 * `storage_lets.lead_id`, a nullable column nothing in the app populates, so
 * for real data the count was always 0 and the refusal never fired
 * (QA-20260820-08).
 *
 * Counting by `client_id` instead is not simply "the same check, fixed". The
 * let itself is never at risk — `client_id` is NOT NULL and deleting a lead
 * does not delete the client, so the storage business survives either way.
 * What a delete can destroy is the ENQUIRY the let came from. A sibling lead
 * on the same client keeps that trail intact, so only the last one is refused;
 * blocking every lead on the client would make an obvious typo duplicate
 * undeletable purely because a sibling has storage business (Peter's call,
 * 2026-08-22).
 */
export function storageLetsBlockingDelete(f: {
  clientId: string | null;
  siblingLeadCount: number;
  letsOnClient: number;
}): number {
  if (!f.clientId) return 0;
  if (f.siblingLeadCount > 0) return 0;
  return f.letsOnClient;
}

export function canDeleteLead(f: LeadDeletionFacts): LeadDeletion {
  // Ordered so the message names the most consequential thing first — the
  // office should hear "this one has money on it", not "this one has a quote".
  if (f.cardPayments > 0) return { deletable: false, reason: "a card payment has been taken against it" };
  if (f.signatures > 0) return { deletable: false, reason: "the customer has signed a document on it" };
  if (f.claims > 0) return { deletable: false, reason: "it has a claim against it" };
  if (f.jobCompletions > 0) return { deletable: false, reason: "the job has been completed" };
  if (f.orphanedStorageLets > 0) return { deletable: false, reason: "it is the last enquiry behind a storage let" };
  if (f.appointments > 0) return { deletable: false, reason: "it is in the diary" };
  if (f.quotes > 0) return { deletable: false, reason: "it has a quote" };
  if (f.cubicSurveys > 0) return { deletable: false, reason: "it has a survey" };
  return { deletable: true };
}
