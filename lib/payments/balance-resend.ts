/**
 * Whether an already-raised final invoice may be SENT AGAIN.
 *
 * Re-sending exists for the customer who wants to settle up before we would
 * have chased them, or who has lost the email (Greig James MMR015, 2026-08-20:
 * invoice raised 14 Aug, he replied five days later asking where to pay). It
 * re-sends the same invoice number, figure and PDF — a second invoice is never
 * created, because one job has one VAT document.
 *
 * Pure so the rule is testable away from Zoho and the mailer, and so the button
 * and the server refuse on identical grounds.
 */
export interface BalanceResendFacts {
  /** Real Zoho invoice id — 'pending' is a CAS claim, not an invoice. */
  invoiceRaised: boolean;
  /** The figure on the raised invoice. */
  invoicedAmount: number;
  bookingCancelled: boolean;
  hasCustomerEmail: boolean;
  /** Settled. Never ask a paid customer to pay again. */
  balancePaid: boolean;
  /**
   * The paid check could not be READ (a query error), which is not the same
   * answer as "not paid". Refuse: the cost of a wrong send here is a settled
   * customer being asked for money they have already handed over.
   */
  paidStateUnknown?: boolean;
}

export type BalanceResend = { ok: true } | { ok: false; reason: string };

export function canResendBalanceInvoice(f: BalanceResendFacts): BalanceResend {
  if (!f.invoiceRaised) {
    return { ok: false, reason: "No final invoice has been raised yet — create it first." };
  }
  if (f.bookingCancelled) {
    return { ok: false, reason: "This booking was cancelled — its final invoice will not be sent again." };
  }
  if (f.paidStateUnknown) {
    return { ok: false, reason: "Could not check whether the balance is already paid." };
  }
  if (f.balancePaid) {
    return { ok: false, reason: "The balance is already paid — nothing to send." };
  }
  if (!f.hasCustomerEmail) {
    return { ok: false, reason: "No email address on this job — add one first." };
  }
  // A raised invoice with no recorded figure means our copy of it is broken;
  // sending an email that names £0 (or omits the amount) is worse than saying so.
  if (!(f.invoicedAmount > 0)) {
    return { ok: false, reason: "The invoiced balance is not recorded — check the invoice in Zoho." };
  }
  return { ok: true };
}
