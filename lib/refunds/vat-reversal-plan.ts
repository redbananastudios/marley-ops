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
  /** Which ledger minted `zohoInvoiceId` (0109) — the payment's OWN stamp,
   *  frozen into the held snapshot. Null resolves downstream to the configured
   *  provider (the codebase's `asProvider` convention), never to a sibling
   *  payment's stamp. Required so a call site cannot forget it. */
  ledgerProvider: string | null;
  /** Stable, unique-per-payment timestamp — anchors the idempotency key. */
  at: string;
  refundDuePence: number;
}

export interface VatReversalStep {
  /** null ⇒ reverseDepositVatInZoho falls back to a human (no wrong-invoice risk). */
  invoiceId: string | null;
  invoiceNumber: string | null;
  /** Which ledger minted `invoiceId` (0109). Travels beside its own id so the
   *  two can never be mismatched — a rail straddling the Zoho→Xero flip holds
   *  a Zoho deposit beside a Xero commitment, and reading either id against
   *  the other's system misroutes a VAT reversal on money already returned. */
  invoiceProvider: string | null;
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
  /** The DEPOSIT slot's 0109 stamp — paired with quoteDepositInvoiceId, which
   *  is the invoice the single-payment collapse reverses against. */
  quoteDepositInvoiceProvider: string | null;
}): VatReversalStep[] {
  const due = input.payments.filter((p) => p.refundDuePence > 0);

  // Single payment (the common deposit-only refund) — unchanged: one reversal
  // against the quote's reliable deposit invoice for the full rail amount.
  if (due.length <= 1) {
    return [
      {
        invoiceId: input.quoteDepositInvoiceId,
        invoiceNumber: input.quoteDepositInvoiceNumber,
        invoiceProvider: input.quoteDepositInvoiceProvider,
        amountPence: input.fullAmountPence,
        idemKey: `${input.rowId}-${input.rail}`,
      },
    ];
  }

  // Multi-payment rail — one reversal per payment against its own invoice,
  // routed to the ledger that minted THAT invoice.
  return due.map((p) => ({
    invoiceId: p.zohoInvoiceId,
    invoiceNumber: null,
    invoiceProvider: p.ledgerProvider,
    amountPence: p.refundDuePence,
    idemKey: `${input.rowId}-${input.rail}-${p.at}`,
  }));
}
