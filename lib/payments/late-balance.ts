/**
 * Late bookings raise the balance in the same breath — multi-brand PRD §3.10
 * Addition 2 (Peter, 2026-08-25).
 *
 * A move inside T-7 already collapses its ask to max(deposit, 25%) in ONE
 * up-front payment (`requestedDeposit` rule 2). What did not collapse was the
 * paperwork: the balance still waited for the T-7 chase cron, which runs at
 * 09:00 the next morning at the earliest — and only once the deposit is paid
 * AND the date confirmed. A customer booking a move for Thursday therefore got
 * asked for 25% on Monday and met the rest of the bill in a second email days
 * later, sometimes after the move. This rule raises it at acceptance instead,
 * so the whole picture arrives in one comms moment.
 *
 * ## Why the contract signature is a condition
 *
 * The cron's own gate is `leads.date_confirmed_at` — "a final invoice names a
 * move date, so it must never be raised against a date nobody confirmed"
 * (Marks Davis MMR019, 2026-08-13: the panel said 25 Aug, the office said the
 * date was never agreed). That stamp CANNOT exist at acceptance: confirming
 * the date requires the deposit to be paid first. So an unconditional raise at
 * acceptance would not merely run ahead of that guard, it would bypass it on
 * every late booking.
 *
 * The nearest evidence of the same kind that IS available at acceptance is the
 * customer's own contract signature — a typed name against the acknowledgment
 * set, on a quote that names the move date. `acceptQuoteOnline` writes that row
 * as part of accepting; office "Mark won" (`acceptQuoteByStaff`) writes no
 * signature at all, which is precisely the MMR019 shape. So the rule is one
 * rule for both paths — *raise early when the customer has signed for this
 * booking* — and a staff-accepted late booking simply keeps today's behaviour
 * (its balance raises from the cron once the customer confirms the date). That
 * is a deliberate narrowing of the PRD's wording, not an oversight.
 *
 * Pure, so the rules are unit-testable away from the flow.
 */
import { legacyLocked, type LegacyLockFields } from "@/lib/legacy";
import { commitmentDueImmediately } from "@/lib/payments-policy";

export interface LateBalanceQuote extends LegacyLockFields {
  status: string;
  moving_date: string | null;
  /** Non-null covers 'pending' too: the CAS claim is held, hands off. */
  zoho_balance_invoice_id: string | null;
  booking_cancelled_at: string | null;
}

/**
 * Should acceptance raise the balance invoice now, rather than leaving it to
 * the T-7 cron?
 *
 * Deliberately NOT checked here: the balance figure. `computeBalanceCredits`
 * owns that, and `createBalanceInvoiceFlow` refuses "nothing left to invoice"
 * before it claims anything — which is exactly what a small job (gate 9a: the
 * ask IS the gross) does, with no side effect and no alert.
 *
 * Also not checked here: commercial quotes, which take no deposit and no
 * balance at all. Gate 10 excludes them at the accept-flow choke point that
 * already guards `ensureDepositInvoice`, rather than in each rule downstream.
 */
export function lateBalanceDueAtAcceptance(
  quote: LateBalanceQuote,
  hasContractSignature: boolean,
  today: Date = new Date(),
): boolean {
  if (quote.status !== "accepted") return false;
  if (quote.booking_cancelled_at) return false;
  // Already raised — or mid-raise. Same rule as balanceInvoiceDue.
  if (quote.zoho_balance_invoice_id) return false;
  // Legacy iMVE bookings stay silent until the office has phoned (0088/0094).
  if (legacyLocked(quote)) return false;
  // The whole trigger: the move is inside the commitment window, so the ask
  // has already collapsed and there is no ladder left to wait for.
  if (!commitmentDueImmediately(quote.moving_date, today)) return false;
  return hasContractSignature;
}
