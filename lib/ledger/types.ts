/**
 * Provider-neutral ledger types — the seam between the app's money code and
 * whichever bookkeeping system is authoritative (Zoho Invoice today, Xero from
 * the cutover). SERVER ONLY: every implementation talks to the real books.
 *
 * Read `docs/ledger-adapter-design.md` before changing anything here. Six of its
 * findings shaped this file and three of them are live-money defects that a
 * straight copy of Zoho's function list would have shipped.
 */

/**
 * The domain status vocabulary — deliberately **Zoho's lowercase set**, not a
 * new neutral enum (design §1).
 *
 * It is already this repo's de-facto language: `lib/finance/invoices.ts`'s
 * unit-tested `isRaised()` pins it, /finance's STATUS_PILL keys off it, and
 * `storage_invoices.status` stores the literal. A new vocabulary would touch 11
 * comparison sites across 5 files — all money code — for no behavioural gain.
 * So each adapter normalises INTO this set, and call sites never change.
 *
 * Xero's own set (DRAFT|SUBMITTED|DELETED|AUTHORISED|PAID|VOIDED) maps in with
 * two documented gaps, handled in the Xero adapter rather than faked here:
 *  - `viewed` is unreachable under Xero (it has only a SentToContact boolean,
 *    which means something else). The /finance "Viewed" pill simply never shows.
 *  - `overdue` is derived from DueDate, which `createInvoice` sets only when a
 *    caller passes one (gate 10b — the commercial ladder does; residential
 *    leaves the provider default, exactly as before).
 */
export type LedgerInvoiceStatusValue =
  | "draft"
  | "sent"
  | "viewed"
  | "unpaid"
  | "partially_paid"
  | "paid"
  | "overdue"
  | "void";

/**
 * What an adapter actually returns: a recognised status, or — when the provider
 * hands back something this adapter does not know — **that provider string,
 * preserved verbatim**.
 *
 * Coercing an unrecognised money status into a known one is a guess about
 * whether a customer has paid, and the surface that would have shown the guess
 * was wrong is the same pill the coercion just made look normal. An unrendered
 * pill is the safe failure. (`string & {}` keeps literal autocomplete on the
 * union while still admitting the escape.)
 */
export type LedgerStatus = LedgerInvoiceStatusValue | (string & {});

/**
 * How the customer's money arrived. Zoho takes this literally as `payment_mode`;
 * Xero has **no mode field at all** and instead names a bank ACCOUNT, so the
 * Xero adapter resolves each of these to an org-specific account code from
 * config (design §3). Getting that mapping wrong puts real customer money in the
 * wrong nominal account, which is why the mode stays on the interface and the
 * codes are never hardcoded.
 */
export type LedgerPaymentMode = "banktransfer" | "cash" | "creditcard";

/**
 * Which system a given document lives in. Stored per-row from gate 18 so a
 * status poll on a months-old invoice id is routed to the system that minted it
 * (design §8) — a single global switch would send every stored Zoho id to Xero
 * the moment the provider flips, and a customer who HAS paid would never be
 * marked paid while the cron kept reporting a healthy run.
 */
export type LedgerProvider = "zoho" | "xero";

/**
 * Errors from any provider. Deliberately a plain `Error` subclass: both
 * area-A call sites narrow with `err instanceof Error` and read only
 * `.message`, and no caller anywhere catches `ZohoError` by type, so this
 * costs nothing and keeps catch blocks provider-blind.
 */
export class LedgerError extends Error {
  constructor(
    message: string,
    /** Provider-native error code, when the provider gives one. */
    public providerCode?: number,
    public httpStatus?: number,
  ) {
    super(message);
    this.name = "LedgerError";
  }
}

/**
 * Verdict of an adapter's org-scoped health probe — see
 * {@link LedgerAdapter.checkAccess}. `accessDenied` separates the PERMANENT
 * lock-out class (deactivated user, revoked grant, dead refresh token, missing
 * creds — a human must act) from a transient blip that clears on the next pass
 * and must not page anyone at 3am. Same shape as `lib/zoho.ts`'s
 * `ZohoAccessCheck`, which the Zoho adapter passes through unchanged.
 */
export type LedgerAccessCheck =
  | { ok: true }
  | { ok: false; accessDenied: boolean; message: string };

export interface LedgerInvoiceRef {
  invoiceId: string;
  invoiceNumber: string;
  /** The hosted customer-facing invoice page, when the provider offers one. */
  invoiceUrl: string | null;
}

export interface LedgerInvoiceStatus extends LedgerInvoiceRef {
  status: LedgerStatus;
  /** Gross (VAT-inclusive) document total. */
  total: number;
  /** Unpaid remainder. */
  balance: number;
}

export interface LedgerInvoiceListItem {
  invoiceId: string;
  invoiceNumber: string;
  /** OUR reference (MMR001-DEP) — the bank-transfer reference, not theirs. */
  reference: string;
  customerName: string;
  /** Invoice date (yyyy-mm-dd) — the "raised on" day /finance groups by. */
  date: string;
  status: LedgerStatus;
  total: number;
  balance: number;
}

export interface LedgerInvoiceList {
  invoices: LedgerInvoiceListItem[];
  /** True when the runaway row cap cut the result short. Money figures built
   *  from a truncated list must SAY so rather than silently understate. */
  truncated: boolean;
}

export interface LedgerCreditNoteRef {
  creditNoteId: string;
  creditNoteNumber: string;
}

export interface CreateInvoiceInput {
  customerId: string;
  reference: string;
  description: string;
  /** Customer-facing total, VAT-inclusive. */
  amount: number;
  notes?: string;
  /**
   * Balance invoices are BACS/cash only (card fees too high at those values —
   * Peter, 2026-07-09).
   *
   * Zoho honours this per invoice (`payment_options.payment_gateways: []`).
   * **Xero cannot**: online payment services attach to a BrandingTheme, so the
   * Xero adapter must satisfy this by raising the invoice under a theme with no
   * payment service attached (design §2). That is why the flag stays a boolean
   * intent here rather than a Zoho-shaped payload.
   */
  disableOnlinePayments?: boolean;
  /** Line-item name — the accountant's income-separation handle. Storage
   *  invoices pass "Storage" so storage income never mixes with Removals
   *  Income (standing policy 2026-07-22). */
  itemName?: string;
  /**
   * When the invoice falls due, `YYYY-MM-DD` (UK calendar day). Omitted leaves
   * the provider's own default, which is what every invoice raised before gate
   * 10b carried — so residential is untouched.
   *
   * This exists for the COMMERCIAL ladder (PRD §3.10), where the due date is
   * the whole substance of "on the client's agreed terms". Without it that date
   * lived only in `quotes.commercial_due_date`, driving our own /bookings
   * overdue state, while the document actually sent to the client's accounts
   * department carried no due date at all — so the one party who has to act on
   * the terms could not see them, and the provider's own `overdue` status could
   * never fire either (see LedgerInvoiceStatusValue above).
   */
  dueDate?: string;
}

export interface CreateCreditNoteInput {
  customerId: string;
  reference: string;
  description: string;
  /** Gross, VAT-inclusive — matches the amount being refunded. */
  amount: number;
  notes?: string;
  itemName?: string;
  /** yyyy-mm-dd; defaults to today (the reversal lands in this VAT period). */
  date?: string;
  /** MIRROR the original invoice's tax treatment instead of re-deriving from
   *  the org's current rate. false means no tax line even if a rate now exists. */
  applyVat?: boolean;
}

export interface RecordPaymentInput {
  /**
   * The provider's contact id. Zoho requires it; **Xero ignores it** — a Xero
   * payment carries no contact, the contact is implied by the invoice. Kept on
   * the interface because Zoho cannot do without it (design §3).
   */
  customerId: string;
  invoiceId: string;
  amount: number;
  mode: LedgerPaymentMode;
  reference?: string;
  /** yyyy-mm-dd (UK day); defaults to today. */
  date?: string;
}

export interface RefundCreditNoteInput {
  creditNoteId: string;
  amount: number;
  mode: LedgerPaymentMode;
  reference?: string;
  description?: string;
  date?: string;
}

/** Returned by `refundCreditNote` when the note has nothing left to refund. */
export const ALREADY_REFUNDED = "already_refunded";

/* The contact key. Defined in its own module because the fallback rule needs to
   log, and this file is otherwise pure type declarations. */
import type { LedgerParty } from "./party";
export type { LedgerParty };

/**
 * The 13 app-facing operations, plus the watchdog's health probe. Measured, not
 * assumed: the other six exports on `lib/zoho.ts` are either test/script
 * cleanup (voidAndDelete*, deletePayment, deleteContact — zero app/ or lib/
 * callers) or internal plumbing (getVatTaxId, isPaymentGatewayActive — no
 * callers outside that module). Neither belongs on a production interface
 * (design §0).
 */
export interface LedgerAdapter {
  readonly provider: LedgerProvider;

  /**
   * Org-scoped health probe: one cheap read that FAILS under this provider's
   * own lock-out class (deactivated user, revoked grant, dead refresh token,
   * disconnected tenant, missing creds), not merely when the host is down.
   *
   * On the interface rather than beside the watchdog because the probe must
   * certify the SAME system the raises use: before this existed the watchdog
   * called Zoho directly, so with `LEDGER_PROVIDER=xero` it greened off a
   * healthy Zoho while Xero was locked out — and then auto-cleared the very
   * lock-out alarm a failed Xero raise had just opened.
   *
   * Zoho probes `GET /settings/currencies` (its `GET /organizations` answers
   * happily for a deactivated user — the 2026-08-27 outage ran green on it for
   * hours). Xero probes `GET /Organisation` through the full token-refresh +
   * tenant chain (`GET /connections` answers with just a bare token).
   *
   * Never throws — a probe failure IS the answer.
   */
  checkAccess(): Promise<LedgerAccessCheck>;

  /* contacts */
  findOrCreateContact(input: {
    name: string;
    email?: string | null;
    phone?: string | null;
    /**
     * WHO this contact is, as a stable id — see {@link LedgerParty}. Required,
     * not optional: an optional field would let a call site added later fall
     * through to name-only resolution under Xero, which is the exact collision
     * it exists to prevent, arriving silently on the money path.
     */
    party: LedgerParty;
  }): Promise<string>;

  /* invoices */
  /**
   * `total` lets adopters verify an orphan bills what we computed (never adopt
   * a mismatch). `dueDate` (yyyy-mm-dd) is the ADOPTED document's own terms
   * date: the adoption path stamps it rather than re-deriving today+terms,
   * because the client already holds a PDF naming this day. Both optional —
   * absence is absence, and adopters must treat a missing date as "no date",
   * never invent one.
   */
  findInvoiceByReference(
    reference: string,
  ): Promise<(LedgerInvoiceRef & { total?: number; dueDate?: string }) | null>;
  createInvoice(input: CreateInvoiceInput): Promise<LedgerInvoiceRef>;
  listInvoices(input: {
    dateStart?: string;
    dateEnd?: string;
    /** Neutral re-expression of Zoho's `filter_by=Status.Unpaid`. `Status.All`
     *  is dead at every call site in the repo and was not ported. */
    status?: "unpaid";
  }): Promise<LedgerInvoiceList>;
  getInvoiceStatus(invoiceId: string): Promise<LedgerInvoiceStatus>;
  invoiceCarriesVat(invoiceId: string): Promise<boolean>;
  getInvoicePdfBase64(invoiceId: string): Promise<string>;
  recordInvoicePayment(input: RecordPaymentInput): Promise<string>;
  voidInvoice(invoiceId: string): Promise<void>;

  /**
   * Office deep link for an invoice. **Synchronous by contract**: it is called
   * inside JSX in a non-async component (finance/page.tsx, inside .map()), so
   * making it async breaks the render (design §10).
   */
  invoiceAppUrl(invoiceId: string): string;

  /* credit notes */
  findCreditNoteByReference(reference: string): Promise<LedgerCreditNoteRef | null>;
  createCreditNote(input: CreateCreditNoteInput): Promise<LedgerCreditNoteRef>;
  /** Returns the refund id, or the {@link ALREADY_REFUNDED} sentinel. */
  refundCreditNote(input: RefundCreditNoteInput): Promise<string>;
}
