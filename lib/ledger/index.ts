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
import type { LedgerParty } from "./party";
import { zohoAdapter } from "./zoho-adapter";
import { xeroAdapter } from "./xero-adapter";

export * from "./types";
export { partyForQuote, type LedgerParty } from "./party";

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
 * Narrow a provider stamp read from the database to a {@link LedgerProvider}.
 *
 * The stamp columns are plain text (migration 0109), so this is the one place
 * that decides what a stored value means.
 *
 * An **unrecognised** stamp throws. Falling back to the configured provider is
 * exactly the bug the stamp exists to prevent — reading a document against a
 * system that never minted it — and after the flip that fallback is silent:
 * a not-found reads as transient, the customer who HAS paid is never marked
 * paid, and the poller keeps reporting a healthy run.
 *
 * **Null** passes through as "no override", which resolves to the configured
 * provider. That is safe only because the database guarantees it: every
 * `*_provider` column carries a CHECK that a stored id (other than the literal
 * `pending` creation claim) cannot exist without its stamp, and 0109 backfilled
 * every pre-existing row. Callers pass null only for a slot that holds no id.
 */
export function asProvider(stamp: string | null | undefined): LedgerProvider | null {
  if (stamp == null) return null;
  if (stamp === "zoho" || stamp === "xero") return stamp;
  throw new LedgerError(
    `Stored ledger provider "${stamp}" is not recognised — expected "zoho" or "xero". ` +
      `Refusing to guess which system this document was raised in.`,
  );
}

/**
 * The contact id to reuse for a raise in `ledger`, or null when a fresh one
 * must be created.
 *
 * A contact id is meaningful only inside the ledger that minted it, and nothing
 * about the id itself says which one that was. The repo's `isRealZohoId` tests
 * non-null and `<> 'pending'` and knows nothing about providers, so on its own
 * it hands Xero a Zoho contact id on every quote raised before the cutover —
 * and `createInvoice` then fails for a reason that reads like an outage.
 *
 * The commitment path is the one that makes this expensive rather than merely
 * wrong: it self-heals from the customer's own `/q` page load, so a customer
 * refreshing their booking would generate a fresh failed create and a fresh ops
 * alert every single time they looked at it.
 *
 * Defined here, beside `asProvider`, because four raise paths need the identical
 * rule and four copies of a condition is how one of them ends up different.
 */
export function reusableContactId(
  contactId: string | null | undefined,
  stamp: string | null | undefined,
  ledger: LedgerProvider,
): string | null {
  if (!contactId || contactId === "pending") return null;
  return asProvider(stamp) === ledger ? contactId : null;
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
      return xeroAdapter;
  }
}

/* ---------------------------------------------------------------- health */

/**
 * Org-scoped probe of ONE provider's access — the watchdog's evidence that the
 * books are actually reachable rather than merely un-exercised. Callers pass
 * the provider they mean to certify (normally `configuredProvider()`), and a
 * green verdict certifies ONLY that provider: any auto-resolve keyed off it
 * must be scoped to the same provider, because a healthy Zoho says nothing
 * about a locked-out Xero and must never clear its alarm.
 */
export function checkLedgerAccess(provider?: LedgerProvider | null) {
  return adapterFor(provider).checkAccess();
}

/* -------------------------------------------------------------- contacts */

export function findOrCreateContact(input: {
  name: string;
  email?: string | null;
  phone?: string | null;
  party: LedgerParty;
}): Promise<string> {
  return adapterFor().findOrCreateContact(input);
}

/* -------------------------------------------------------------- invoices */

export function findInvoiceByReference(
  reference: string,
): Promise<(LedgerInvoiceRef & { total?: number; dueDate?: string }) | null> {
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
