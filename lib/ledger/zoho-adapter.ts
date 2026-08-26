/**
 * Zoho implementation of {@link LedgerAdapter} — SERVER ONLY.
 *
 * **Zero behaviour change is this file's whole contract.** It is a thin,
 * deliberately boring translation over `lib/zoho.ts`, which keeps its HTTP
 * client, its OAuth caching and its request shapes exactly as they are on the
 * live books. Nothing here re-implements a Zoho call; if a body or a guard
 * needs changing, change it in `lib/zoho.ts` so the existing tests still cover
 * it.
 *
 * Two translations are real rather than pass-through, and both are documented
 * where they happen: the neutral `status: "unpaid"` filter, and error wrapping.
 * Status values need no mapping at all — the neutral vocabulary IS Zoho's
 * lowercase set, chosen for exactly that reason (design §1).
 */
import {
  ZohoError,
  createCreditNote as zCreateCreditNote,
  createInvoice as zCreateInvoice,
  findCreditNoteByReference as zFindCreditNoteByReference,
  findInvoiceByReference as zFindInvoiceByReference,
  findOrCreateContact as zFindOrCreateContact,
  getInvoicePdfBase64 as zGetInvoicePdfBase64,
  getInvoiceStatus as zGetInvoiceStatus,
  invoiceCarriesVat as zInvoiceCarriesVat,
  listInvoices as zListInvoices,
  recordInvoicePayment as zRecordInvoicePayment,
  refundCreditNote as zRefundCreditNote,
  voidInvoice as zVoidInvoice,
  zohoInvoiceAppUrl,
} from "@/lib/zoho";
import type {
  CreateCreditNoteInput,
  CreateInvoiceInput,
  LedgerAdapter,
  LedgerCreditNoteRef,
  LedgerInvoiceList,
  LedgerInvoiceRef,
  LedgerInvoiceStatus,
  RecordPaymentInput,
  RefundCreditNoteInput,
} from "./types";
import { LedgerError } from "./types";

/**
 * Re-clothe a provider error as a `LedgerError` so `catch` blocks never have to
 * know which system is authoritative.
 *
 * The message is carried across **verbatim** — `voidInvoice`'s
 * `Refusing to void <n>: payment already applied` is read by a human in an ops
 * alert and is under test, so it must survive the seam byte-for-byte. Anything
 * that is not a `ZohoError` (a network abort, a bug in our own code) is
 * rethrown untouched rather than being relabelled as a ledger fault.
 */
function asLedgerError(err: unknown): never {
  if (err instanceof ZohoError) {
    throw new LedgerError(err.message, err.zohoCode, err.httpStatus);
  }
  throw err;
}

async function wrap<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    asLedgerError(err);
  }
}

export const zohoAdapter: LedgerAdapter = {
  provider: "zoho",

  findOrCreateContact: (input) => wrap(() => zFindOrCreateContact(input)),

  findInvoiceByReference: (reference): Promise<(LedgerInvoiceRef & { total?: number }) | null> =>
    wrap(() => zFindInvoiceByReference(reference)),

  createInvoice: (input: CreateInvoiceInput): Promise<LedgerInvoiceRef> =>
    wrap(() => zCreateInvoice(input)),

  /**
   * `Status.Unpaid` is Zoho's own vocabulary (sent + viewed + overdue +
   * partially paid) and was hardcoded at the /finance call site. It is
   * re-expressed neutrally here. `Status.All` was dead at every call site in
   * the repo and is deliberately not ported (design §10).
   */
  listInvoices: (input): Promise<LedgerInvoiceList> =>
    wrap(() =>
      zListInvoices({
        dateStart: input.dateStart,
        dateEnd: input.dateEnd,
        ...(input.status === "unpaid" ? { filterBy: "Status.Unpaid" as const } : {}),
      }),
    ),

  getInvoiceStatus: (invoiceId): Promise<LedgerInvoiceStatus> =>
    wrap(() => zGetInvoiceStatus(invoiceId)),

  invoiceCarriesVat: (invoiceId) => wrap(() => zInvoiceCarriesVat(invoiceId)),

  getInvoicePdfBase64: (invoiceId) => wrap(() => zGetInvoicePdfBase64(invoiceId)),

  recordInvoicePayment: (input: RecordPaymentInput) => wrap(() => zRecordInvoicePayment(input)),

  voidInvoice: (invoiceId) => wrap(() => zVoidInvoice(invoiceId)),

  /** Synchronous by contract — called inside JSX in a non-async component. */
  invoiceAppUrl: (invoiceId) => zohoInvoiceAppUrl(invoiceId),

  findCreditNoteByReference: (reference): Promise<LedgerCreditNoteRef | null> =>
    wrap(() => zFindCreditNoteByReference(reference)),

  createCreditNote: (input: CreateCreditNoteInput): Promise<LedgerCreditNoteRef> =>
    wrap(() => zCreateCreditNote(input)),

  refundCreditNote: (input: RefundCreditNoteInput) => wrap(() => zRefundCreditNote(input)),
};
