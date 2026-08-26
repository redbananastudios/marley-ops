/**
 * The ledger seam — SERVER ONLY. Every money call site imports from here, never
 * from a provider module.
 *
 * Today this resolves to Zoho and behaves identically to calling `lib/zoho.ts`
 * directly; that identity IS gate 17's contract. Gate 18 adds the Xero adapter
 * behind the same functions.
 *
 * Design notes and the traps that shaped this file: `docs/ledger-adapter-design.md`.
 */
import type {
  CreateCreditNoteInput,
  CreateInvoiceInput,
  LedgerAdapter,
  LedgerCreditNoteRef,
  LedgerInvoiceList,
  LedgerInvoiceRef,
  LedgerInvoiceStatus,
  LedgerProvider,
  RecordPaymentInput,
  RefundCreditNoteInput,
} from "./types";
import { LedgerError } from "./types";
import { zohoAdapter } from "./zoho-adapter";

export * from "./types";

/**
 * Which system NEW documents are raised in. Unset means Zoho — today's
 * behaviour, so an untouched environment changes by nothing.
 *
 * An unrecognised value **throws** rather than falling back. A typo'd
 * `LEDGER_PROVIDER=xerro` that silently resolved to Zoho would keep raising
 * real customer invoices in the system everyone had just stopped reading, and
 * nothing on any screen would say so. Same fail-closed posture as
 * `LEAD_SYNC_SINCE` (`2ba1a0e`).
 */
export function configuredProvider(): LedgerProvider {
  const raw = (process.env.LEDGER_PROVIDER ?? "zoho").trim().toLowerCase();
  if (raw === "zoho" || raw === "xero") return raw;
  throw new LedgerError(
    `LEDGER_PROVIDER is "${process.env.LEDGER_PROVIDER}" — expected "zoho" or "xero". ` +
      `Refusing to guess which system the books are in.`,
  );
}

/**
 * Resolve one adapter.
 *
 * `provider` is the **per-document override** and exists for design §8: an
 * invoice id stored months ago belongs to whichever system minted it, and after
 * the flip a global switch would send every stored Zoho id to Xero. Best case
 * that throws forever; worst case a not-found reads as transient and a customer
 * who HAS paid is never marked paid while the cron keeps reporting a healthy
 * run. Gate 18 stores the provider per row and passes it here. Until then every
 * caller omits it and gets the configured default — which is the same adapter.
 */
export function adapterFor(provider?: LedgerProvider | null): LedgerAdapter {
  const target = provider ?? configuredProvider();
  switch (target) {
    case "zoho":
      return zohoAdapter;
    case "xero":
      throw new LedgerError(
        "The Xero adapter has not shipped yet (gate 18). Set LEDGER_PROVIDER=zoho.",
      );
  }
}

/* -------------------------------------------------------------- contacts */

export function findOrCreateContact(input: {
  name: string;
  email?: string | null;
  phone?: string | null;
}): Promise<string> {
  return adapterFor().findOrCreateContact(input);
}

/* -------------------------------------------------------------- invoices */

export function findInvoiceByReference(
  reference: string,
): Promise<(LedgerInvoiceRef & { total?: number }) | null> {
  return adapterFor().findInvoiceByReference(reference);
}

export function createInvoice(input: CreateInvoiceInput): Promise<LedgerInvoiceRef> {
  return adapterFor().createInvoice(input);
}

export function listInvoices(input: {
  dateStart?: string;
  dateEnd?: string;
  status?: "unpaid";
}): Promise<LedgerInvoiceList> {
  return adapterFor().listInvoices(input);
}

/* The reads below all take an id that was stored EARLIER, so each carries the
 * optional per-document provider override described on `adapterFor`. */

export function getInvoiceStatus(
  invoiceId: string,
  provider?: LedgerProvider | null,
): Promise<LedgerInvoiceStatus> {
  return adapterFor(provider).getInvoiceStatus(invoiceId);
}

export function invoiceCarriesVat(
  invoiceId: string,
  provider?: LedgerProvider | null,
): Promise<boolean> {
  return adapterFor(provider).invoiceCarriesVat(invoiceId);
}

export function getInvoicePdfBase64(
  invoiceId: string,
  provider?: LedgerProvider | null,
): Promise<string> {
  return adapterFor(provider).getInvoicePdfBase64(invoiceId);
}

export function recordInvoicePayment(
  input: RecordPaymentInput,
  provider?: LedgerProvider | null,
): Promise<string> {
  return adapterFor(provider).recordInvoicePayment(input);
}

export function voidInvoice(invoiceId: string, provider?: LedgerProvider | null): Promise<void> {
  return adapterFor(provider).voidInvoice(invoiceId);
}

/** Synchronous by contract — called inside JSX in a non-async component. */
export function invoiceAppUrl(invoiceId: string, provider?: LedgerProvider | null): string {
  return adapterFor(provider).invoiceAppUrl(invoiceId);
}

/* --------------------------------------------------------- credit notes */

export function findCreditNoteByReference(reference: string): Promise<LedgerCreditNoteRef | null> {
  return adapterFor().findCreditNoteByReference(reference);
}

export function createCreditNote(input: CreateCreditNoteInput): Promise<LedgerCreditNoteRef> {
  return adapterFor().createCreditNote(input);
}

export function refundCreditNote(
  input: RefundCreditNoteInput,
  provider?: LedgerProvider | null,
): Promise<string> {
  return adapterFor(provider).refundCreditNote(input);
}
