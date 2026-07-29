/**
 * Plan the per-payment Zoho VAT reversals for a bank/cash rail refund.
 *
 * A rail can aggregate payments invoiced under DIFFERENT invoices — e.g. a deposit
 * invoiced BEFORE VAT was enabled (no VAT) plus a later commitment invoiced AFTER
 * (with VAT). Reversing the whole rail against only the deposit invoice would
 * mirror the wrong VAT treatment for the later payments. So each payment reverses
 * against its OWN invoice.
 *
 * The overwhelming common case — a single-payment rail (a deposit-only refund) —
 * deliberately collapses to ONE step against the quote's (reliable) deposit
 * invoice, byte-identical to the pre-per-payment behaviour, so nothing regresses
 * for ordinary refunds. A payment whose own invoice id is unknown yields a null
 * invoice, which `reverseDepositVatInZoho` turns into a safe manual reminder
 * (never a reversal against the wrong invoice).
 */

export interface RailPaymentForReversal {
  zohoInvoiceId: string | null;
  /** Stable, unique-per-payment timestamp — anchors the idempotency key. */
  at: string;
  refundDuePence: number;
}

export interface VatReversalStep {
  /** null ⇒ reverseDepositVatInZoho falls back to a human (no wrong-invoice risk). */
  invoiceId: string | null;
  invoiceNumber: string | null;
  amountPence: number;
  /** Stable-per-refund-event key for the credit-note reference (idempotency). */
  idemKey: string;
}

export function planRailVatReversals(input: {
  rail: string;
  rowId: string;
  /** The full rail refund amount (pence) — used for the single-payment collapse. */
  fullAmountPence: number;
  payments: RailPaymentForReversal[];
  quoteDepositInvoiceId: string | null;
  quoteDepositInvoiceNumber: string | null;
}): VatReversalStep[] {
  const due = input.payments.filter((p) => p.refundDuePence > 0);

  // Single payment (the common deposit-only refund) — unchanged: one reversal
  // against the quote's reliable deposit invoice for the full rail amount.
  if (due.length <= 1) {
    return [
      {
        invoiceId: input.quoteDepositInvoiceId,
        invoiceNumber: input.quoteDepositInvoiceNumber,
        amountPence: input.fullAmountPence,
        idemKey: `${input.rowId}-${input.rail}`,
      },
    ];
  }

  // Multi-payment rail — one reversal per payment against its own invoice.
  return due.map((p) => ({
    invoiceId: p.zohoInvoiceId,
    invoiceNumber: null,
    amountPence: p.refundDuePence,
    idemKey: `${input.rowId}-${input.rail}-${p.at}`,
  }));
}
