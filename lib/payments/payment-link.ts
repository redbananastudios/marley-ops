import { legacyLocked, type LegacyLockFields } from "@/lib/legacy";

/**
 * Gate 9d (multi-brand PRD §3.10) — the office "Send payment link" action.
 *
 * The case this exists for: a customer phones in who cannot do a bank transfer.
 * The office mints a tokenised card page for exactly ONE ask and emails or texts
 * it, rather than reading card details over the phone.
 *
 * ## Why this covers the ACCEPTANCE ASK and nothing else
 *
 * The PRD's §3.10 sentence lists "deposit, commitment, full or balance". Three
 * layers of this codebase say the last two must not be card-payable, and they
 * are not incidental:
 *
 *   - `CommitmentPaidOpts.method` is `"bank_transfer" | "cash"`, commented
 *     "Commitment is BACS/cash only by policy (card stays deposit-only)".
 *   - `markBalancePaid` takes the same two methods and no third.
 *   - `lib/ledger/xero-config.ts` THROWS rather than raise a balance invoice
 *     under a theme that could offer Pay Now, and says why: the failure it
 *     prevents is "the silent reversal of that pricing decision" (card fees are
 *     too high at those values, Peter 2026-07-09).
 *
 * A takepayments link for a commitment or a balance would reverse that decision
 * through a different door - not by attaching a payment service to an invoice,
 * but by charging the same money on the same card rails while the guard that
 * exists to prevent it looks the other way. So this rule refuses those kinds,
 * and refusing is a decision recorded here rather than an omission.
 *
 * "Full" is not a missing fourth kind: after gate 9a the acceptance ask for a
 * small job IS the whole price, and it still settles through `deposit_paid_at`.
 * The same is true of gate 9b's collapsed late-booking ask. One kind, three
 * amounts, all of them the deposit rung.
 *
 * Pure and IO-free, like every other rule in this directory, so the office UI,
 * the server action and the tests all consult the same answer.
 */

export interface PaymentLinkQuote extends LegacyLockFields {
  status: string;
  /** Non-null means the ask is already settled - nothing left to send. */
  deposit_paid_at: string | null;
  deposit_amount: number | null;
  booking_cancelled_at: string | null;
  booking_cancelled_reason?: string | null;
}

export type PaymentLinkVerdict =
  | { ok: true; amountPence: number }
  /** Why the office cannot send one, in words the office can act on. */
  | { ok: false; reason: string };

/**
 * Whether the office may send a card payment link for this quote, and for how
 * much.
 *
 * `cardOk` is the caller's resolved `cardPaymentsAvailable(sb, quote.brand)` -
 * the global kill switch AND the brand switch AND the takepayments credentials,
 * already ANDed there (PRD §11.10). It is passed in rather than re-derived so
 * this stays pure, and so no surface can accidentally consult a different pair.
 *
 * `defaultDeposit` comes from business_settings, exactly as `startCardPayment`
 * resolves it, so the figure quoted on the link is the figure the mint will
 * charge.
 */
export function paymentLinkFor(
  quote: PaymentLinkQuote,
  cardOk: boolean,
  defaultDeposit: number,
): PaymentLinkVerdict {
  // The brand's own switch is part of cardOk. A brand with card off must not
  // see the action at all, or the office offers a channel whose every email
  // says bank transfer is the only route.
  if (!cardOk) return { ok: false, reason: "Card payments are off for this brand." };
  if (quote.status !== "accepted") {
    return { ok: false, reason: "The customer has not accepted this quote yet." };
  }
  if (quote.booking_cancelled_at) return { ok: false, reason: "This booking is cancelled." };
  // Legacy iMVE jobs were sold under the old system's terms and their money
  // moves are manual by design.
  if (legacyLocked(quote)) return { ok: false, reason: "Legacy booking - take payment manually." };
  if (quote.deposit_paid_at) return { ok: false, reason: "This has already been paid." };

  const amount = Number(quote.deposit_amount ?? defaultDeposit);
  const amountPence = Math.round(amount * 100);
  if (!Number.isFinite(amountPence) || amountPence <= 0) {
    return { ok: false, reason: "No amount is set for this quote." };
  }
  return { ok: true, amountPence };
}
