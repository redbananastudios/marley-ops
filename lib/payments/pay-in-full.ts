/**
 * Settle in full at the commitment step — multi-brand PRD §3.10 Addition 3
 * (Peter, 2026-08-25).
 *
 * At the commitment step the ladder asks for 25% now and the rest at T-7. Some
 * customers would rather clear it in one transfer and stop thinking about it.
 * Choosing that raises the T-7 balance invoice EARLY, alongside the commitment:
 * two open invoices, individually matchable, **no new `match_kind` and no new
 * invoice suffix**. A single bank transfer covering both is exactly the case
 * `lib/bank-feed/whole-quote.ts` already handles — exact pennies against the
 * summed set, offered to the office, never auto-matched.
 *
 * Ignoring the option changes nothing: the commitment chases as it does today
 * and the balance raises at T-7 as it does today. That is the whole safety
 * property of this feature, and it is why the rule below is a set of gates
 * rather than a preference.
 *
 * ## Why it needs the commitment invoice to exist
 *
 * The option is "settle the rest of it now", so there has to be a rest. Three
 * cases already have nothing to offer and must not render one:
 *
 *  - **A late booking** (gate 9b) had its balance raised at acceptance and its
 *    commitment clamped to zero. The customer can already see everything.
 *  - **A small job** (gate 9a) was asked for the whole price at acceptance.
 *  - **A deposit that covers the 25%** leaves no commitment invoice, so there is
 *    no commitment step to attach the choice to. Those settle at T-7 as today.
 *
 * All three fall out of `commitmentRaised && !commitmentPaid` rather than being
 * special-cased, which is the point.
 *
 * Pure, so the rules are unit-testable away from the flow.
 */
import { legacyLocked, type LegacyLockFields } from "@/lib/legacy";

export interface PayInFullQuote extends LegacyLockFields {
  status: string;
  booking_cancelled_at: string | null;
  deposit_paid_at: string | null;
  zoho_commitment_invoice_id: string | null;
  commitment_paid_at: string | null;
  /** Non-null covers 'pending' too: the CAS claim is held, hands off. */
  zoho_balance_invoice_id: string | null;
}

export interface PayInFullLead {
  /** The Payments Policy v2 ladder flag. Null = the step hasn't been reached. */
  date_confirmed_at: string | null;
  balance_paid_at: string | null;
}

/**
 * May this booking be offered (and allowed) to settle in full right now?
 *
 * One function for the render and the action deliberately: an option the page
 * shows but the server would refuse is worse than no option, and an action the
 * server accepts without the page offering it is an unguarded money path.
 */
export function payInFullAvailable(
  quote: PayInFullQuote,
  lead: PayInFullLead | null | undefined,
): boolean {
  if (quote.status !== "accepted") return false;
  if (quote.booking_cancelled_at) return false;
  // Legacy iMVE bookings were sold under the old system's terms and never
  // agreed a commitment ladder at all (0088/0094).
  if (legacyLocked(quote)) return false;
  if (!lead?.date_confirmed_at) return false;
  if (lead.balance_paid_at) return false;
  // The deposit is what the date confirmation is built on; without it the
  // customer is not at this step.
  if (!quote.deposit_paid_at) return false;
  // There must be a commitment still to pay — see the note above. The literal
  // 'pending' is the CAS claim another caller is holding mid-raise: an invoice
  // that does not exist yet cannot be settled early. Checked here rather than
  // through accept-flow's isRealZohoId, which would drag the whole server graph
  // into this pure module (same reason lib/payments/invoice-resend.ts takes
  // plain facts).
  const commitmentRaised =
    !!quote.zoho_commitment_invoice_id && quote.zoho_commitment_invoice_id !== "pending";
  if (!commitmentRaised) return false;
  if (quote.commitment_paid_at) return false;
  // Already raised (or mid-raise): the choice has been taken, or the T-7 cron
  // got there first. Either way there is nothing left to offer.
  if (quote.zoho_balance_invoice_id) return false;
  return true;
}
