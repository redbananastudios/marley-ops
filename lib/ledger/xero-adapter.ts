/**
 * Xero implementation of {@link LedgerAdapter} — SERVER ONLY.
 *
 * This file is deliberately almost empty. Every operation lives in a module
 * beside it (`xero-contacts`, `xero-invoices`, `xero-credit-notes`, configured
 * by `xero-config`); all this does is bind those thirteen functions to the
 * interface.
 *
 * That binding is the point, and it was the gap the review found. Until an
 * object was declared `: LedgerAdapter`, nothing checked that the modules
 * actually satisfied the seam — the operations were verified by a human reading
 * thirteen signatures side by side, and `adapterFor("xero")` still threw "not
 * shipped yet", so `LEDGER_PROVIDER=xero` could not be exercised at all. One
 * line per operation turns that manual comparison into a compiler gate: a
 * renamed input field, a `Promise<void>` where a `Promise<string>` is required,
 * a missed optional, now fails `tsc` rather than waiting for the cutover.
 *
 * ## Error wrapping
 *
 * Unlike the Zoho adapter there is no `wrap()` here. `lib/zoho.ts` predates the
 * seam and throws its own `ZohoError`, so that adapter has to re-clothe them;
 * these modules were written against the seam and raise {@link LedgerError}
 * directly, with the provider's code and HTTP status already attached — which
 * is what `isLedgerAccessDenied` reads to tell a permanent lock-out from a blip.
 *
 * ## What is NOT here
 *
 * No fallbacks. Every org-specific value (account ids, tax types, branding
 * themes, the short code) is resolved by `xero-config` and **fails closed**
 * naming its own environment variable. An adapter that quietly substituted a
 * default would put real customer money in the wrong nominal account, which is
 * the one failure this whole seam exists to make impossible.
 */
import { findOrCreateXeroContact } from "./xero-contacts";
import {
  createCreditNote,
  findCreditNoteByReference,
  refundCreditNote,
} from "./xero-credit-notes";
import {
  createInvoice,
  findInvoiceByReference,
  getInvoicePdfBase64,
  getInvoiceStatus,
  invoiceAppUrl,
  invoiceCarriesVat,
  listInvoices,
  recordInvoicePayment,
  voidInvoice,
} from "./xero-invoices";
import type { LedgerAdapter } from "./types";

export const xeroAdapter: LedgerAdapter = {
  provider: "xero",

  /* contacts */
  findOrCreateContact: findOrCreateXeroContact,

  /* invoices */
  findInvoiceByReference,
  createInvoice,
  listInvoices,
  getInvoiceStatus,
  invoiceCarriesVat,
  getInvoicePdfBase64,
  recordInvoicePayment,
  voidInvoice,
  /** Synchronous by contract — called inside JSX in a non-async component. */
  invoiceAppUrl,

  /* credit notes */
  findCreditNoteByReference,
  createCreditNote,
  refundCreditNote,
};
