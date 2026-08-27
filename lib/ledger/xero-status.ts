/**
 * Xero invoice status → this repo's status vocabulary.
 *
 * Pure, no IO: the Xero adapter's HTTP layer needs live credentials before it
 * can be trusted, but this mapping does not, and it is the part with the
 * highest cost of being wrong. Eleven comparison sites across five files read
 * these strings raw, including the branch in `accept-flow.ts` that marks a
 * deposit PAID and the write into `storage_invoices.status`.
 *
 * Direction of travel is deliberate (design §1): each adapter normalises INTO
 * Zoho's lowercase set rather than everyone moving to a new neutral enum. That
 * vocabulary is already the repo's domain language — `isRaised()` pins it,
 * /finance's STATUS_PILL keys off it — so normalising here means zero call-site
 * churn on money code.
 *
 * Source of truth for the input set is `Invoice.Status` in `xero_accounting.yaml`:
 * DRAFT | SUBMITTED | DELETED | AUTHORISED | PAID | VOIDED. The spec's own
 * `_autodocs/types.md` summary shows a shortened list that OMITS `AUTHORISED`,
 * which is the status almost every live invoice sits in — do not use it. That
 * summary has now been wrong about three separate things, so anything taken
 * from it is verified against the yaml first.
 */
import type { LedgerStatus } from "./types";

/** What Xero reports. Kept as its own type so an unknown value is a compile error. */
export type XeroInvoiceStatus =
  | "DRAFT"
  | "SUBMITTED"
  | "DELETED"
  | "AUTHORISED"
  | "PAID"
  | "VOIDED";

export interface XeroInvoiceAmounts {
  /** Xero's `AmountPaid`. */
  amountPaid: number;
  /** Xero's `AmountDue`. */
  amountDue: number;
  /** Xero's `DueDate`, yyyy-mm-dd. Absent on invoices raised without terms. */
  dueDate?: string | null;
}

/**
 * Map one Xero status to ours.
 *
 * Three of the six need the amounts or the date as well, because Xero carries
 * the distinction in a different field rather than in the status:
 *
 * - `AUTHORISED` is Xero's "raised and owed". It covers three of ours —
 *   `partially_paid` when money has landed but not all of it, `overdue` when
 *   the due date has passed, and `sent` otherwise.
 * - `partially_paid` needs BOTH `amountPaid > 0` and `amountDue > 0`. Testing
 *   only the first would report a fully-settled invoice as partially paid in
 *   the window before Xero moves it to PAID.
 * - `overdue` is derived from `DueDate`, which `createInvoice` does not set
 *   today. Until gate 10 sets terms, a Xero invoice simply never reads
 *   `overdue` — stated rather than faked.
 *
 * Two mappings are deliberately absent:
 *
 * - **`viewed` is unreachable.** Xero has only a `SentToContact` boolean, which
 *   means "we marked it sent", not "the customer opened it". Synthesising
 *   `viewed` from it would put a stronger claim on the /finance pill than the
 *   data supports. The pill simply never shows for a Xero invoice.
 * - **No fallback.** An unrecognised status is returned VERBATIM rather than
 *   coerced, matching {@link LedgerStatus}. Coercing an unknown money status is
 *   a guess about whether a customer has paid, and the surface that would have
 *   shown the guess was wrong is the same pill the coercion just made look
 *   normal. An unrendered pill is the safe failure.
 *
 * `DELETED` maps to `void`: it is terminal for a draft, and every place the app
 * excludes `void` (`isRaised()`, the /finance filters) means exactly "this
 * document no longer represents money owed". Giving it its own value would
 * require auditing all eleven comparison sites to add it.
 *
 * @param today UK-day `yyyy-mm-dd`, injected so the overdue branch is testable
 *              and so callers cannot disagree about the timezone.
 */
export function ledgerStatusFromXero(
  status: string,
  amounts: XeroInvoiceAmounts,
  today: string,
): LedgerStatus {
  switch (status) {
    case "DRAFT":
      return "draft";
    // Awaiting internal approval — raised in Xero's eyes, but not yet owed by
    // anyone, so it reads as a draft to us rather than as sent.
    case "SUBMITTED":
      return "draft";
    case "PAID":
      return "paid";
    case "VOIDED":
    case "DELETED":
      return "void";
    case "AUTHORISED": {
      if (amounts.amountPaid > 0 && amounts.amountDue > 0) return "partially_paid";
      if (amounts.dueDate && amounts.dueDate < today) return "overdue";
      return "sent";
    }
    default:
      // Preserved verbatim, never coerced. See the note above.
      return status;
  }
}

/**
 * True when Xero reports a status this build understands.
 *
 * Exposed so the adapter can LOG an unrecognised status rather than let it pass
 * silently into the app: the verbatim pass-through above is the safe rendering,
 * but nobody finds out about it unless something says so. Same rule as the
 * blind-sweep helper — a component that cannot do its job reports that, rather
 * than a quiet success.
 */
export function isKnownXeroStatus(status: string): status is XeroInvoiceStatus {
  return (
    status === "DRAFT" ||
    status === "SUBMITTED" ||
    status === "DELETED" ||
    status === "AUTHORISED" ||
    status === "PAID" ||
    status === "VOIDED"
  );
}
