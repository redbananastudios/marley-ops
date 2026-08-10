/**
 * What a follow-up card calls itself.
 *
 * The chip used to be keyed on `reason` alone, and five different things share
 * reason='custom' — a customer reply, a bounced address, the commitment ladder,
 * a crew sign-off problem and a Zoho credit note all rendered as an identical
 * grey "Follow-up". The queue was unreadable without opening each lead, which is
 * how stale tasks hid in plain sight (Peter, 2026-08-10).
 *
 * `source` is the discriminator. It is a free-text column with no CHECK, so an
 * unknown value must never render blank — everything falls back to the reason's
 * own label, and reason IS constrained (a 5-value Postgres enum).
 */

export interface FollowUpLabel {
  label: string;
  cls: string;
  /** Queue sort order — most urgent first. */
  rank: number;
}

/** Base look per reason. Reason is an enum, so this is exhaustive. */
export const REASON_META: Record<string, FollowUpLabel> = {
  no_answer: { label: "No answer", cls: "bg-danger-bg text-danger", rank: 0 },
  deposit: { label: "Deposit", cls: "bg-warn-bg text-warn", rank: 1 },
  balance: { label: "Balance", cls: "bg-warn-bg text-warn", rank: 2 },
  quote_followup: { label: "Quote follow-up", cls: "bg-[#eff6ff] text-[#2563eb]", rank: 3 },
  custom: { label: "Follow-up", cls: "bg-muted text-mist-500", rank: 4 },
};

/**
 * Overrides for sources worth naming. Only reason='custom' sources need this —
 * the other four reasons already say what they are.
 *
 * Ranks put the two that mean "a person is waiting on us" above the back-office
 * jobs: a customer's reply sitting unanswered costs more than a credit note.
 */
const SOURCE_META: Record<string, FollowUpLabel> = {
  inbound_reply: { label: "Customer replied", cls: "bg-[#eff6ff] text-[#2563eb]", rank: 1 },
  email_bounced: { label: "Bounced email", cls: "bg-danger-bg text-danger", rank: 1 },
  commitment_chase: { label: "Commitment", cls: "bg-warn-bg text-warn", rank: 2 },
  sign_off_exception: { label: "Crew issue", cls: "bg-danger-bg text-danger", rank: 1 },
  card_payment: { label: "Credit note", cls: "bg-warn-bg text-warn", rank: 3 },
};

export function followUpLabel(reason: string | null, source: string | null): FollowUpLabel {
  const base = REASON_META[reason ?? ""] ?? REASON_META.custom;
  // Only rename the catch-all reason. A 'balance' task from post_move_overdue is
  // still a balance chase; relabelling it by source would lose the money signal.
  if (reason !== "custom") return base;
  return (source && SOURCE_META[source]) || base;
}
