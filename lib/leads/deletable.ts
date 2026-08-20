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
  storageLets: number;
  claims: number;
  jobCompletions: number;
}

export type LeadDeletion =
  | { deletable: true }
  | { deletable: false; reason: string };

export function canDeleteLead(f: LeadDeletionFacts): LeadDeletion {
  // Ordered so the message names the most consequential thing first — the
  // office should hear "this one has money on it", not "this one has a quote".
  if (f.cardPayments > 0) return { deletable: false, reason: "a card payment has been taken against it" };
  if (f.signatures > 0) return { deletable: false, reason: "the customer has signed a document on it" };
  if (f.claims > 0) return { deletable: false, reason: "it has a claim against it" };
  if (f.jobCompletions > 0) return { deletable: false, reason: "the job has been completed" };
  if (f.storageLets > 0) return { deletable: false, reason: "it has a storage let" };
  if (f.appointments > 0) return { deletable: false, reason: "it is in the diary" };
  if (f.quotes > 0) return { deletable: false, reason: "it has a quote" };
  if (f.cubicSurveys > 0) return { deletable: false, reason: "it has a survey" };
  return { deletable: true };
}
