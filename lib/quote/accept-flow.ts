/**
 * Online acceptance + deposit + balance flow core — SERVER ONLY.
 *
 * The lifecycle this file owns:
 *   sent → customer accepts at /q/<token> (typed name) → quote accepted +
 *   lead PROVISIONAL + £deposit Zoho invoice raised → deposit paid (card via
 *   Zoho, or BACS one-tap in ops) → lead CONFIRMED + confirmation email →
 *   customer CONFIRMS THE MOVE DATE (tick + signature on /q, or collected in
 *   person) → deposit becomes non-refundable + commitment invoice raised
 *   (25% of gross minus deposit, due move−7d — Payments Policy v2) →
 *   commitment paid → pre-move "Final invoice" button → balance Zoho invoice
 *   (agreed minus payments received) + email → balance paid → all settled.
 *
 * Invoice idempotency (VAT liability — NEVER create twice): the zoho_*_invoice_id
 * column is claimed with a NULL→'pending' conditional update before any Zoho
 * call; only one caller can win the claim. A crash between Zoho-create and the
 * DB write-back is covered by reference-number orphan adoption (-DEP / -BAL /
 * -COM). Customer emails ride the content-hash duplicate guard in dispatchComm.
 */

import { randomBytes } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { getBusinessSettings } from "@/lib/settings";
import { ukTimeAt, ukInstant } from "@/lib/uk-time";
import { dispatchComm, sendOpsAlert } from "@/lib/comms/dispatch";
import { escapeHtml } from "@/lib/comms/escape-html";
import { paymentPush } from "@/lib/push/categories";
import { accountsFromFor, ownerIdentity } from "@/lib/comms/sender";
import { type Brand, DEFAULT_BRAND, getBrandOrDefault } from "@/lib/brand";
import { templateIdFor } from "@/lib/comms/template-id";
import { ensureRemovalAppointment } from "@/lib/schedule/ensure-removal-appointment";
import { log, errorContext } from "@/lib/log";
import { sendPushForEvent } from "@/lib/push/send";
import {
  allAcksConfirmed,
  allDateConfirmAcksConfirmed,
  channelLabel,
  isValidSignatureDataUri,
  normalizeAcks,
  normalizeDateConfirmAcks,
} from "@/lib/signatures";
import { termsSnapshot } from "@/lib/legal/documents";
import {
  buildDepositReceivedEmailHtml,
  buildBalanceInvoiceEmailHtml,
  buildBalanceReceivedEmailHtml,
  depositReceivedTemplateVars,
  balanceInvoiceTemplateVars,
  balanceReceivedTemplateVars,
  ukReceiptDate,
  paymentMethodLabel,
  type DepositReceivedMeta,
  type BalanceInvoiceMeta,
  type ReceiptDetails,
} from "@/lib/comms/payment-email";
import {
  buildCommitmentReceivedEmailHtml,
  buildDateConfirmationEmailHtml,
  commitmentReceivedTemplateVars,
  dateConfirmationTemplateVars,
  type CommitmentReceivedMeta,
  type DateConfirmationMeta,
} from "@/lib/comms/date-confirm-email";
import {
  commitmentAmount,
  commitmentDueDate,
  DEFAULT_PAYMENT_TERMS_DAYS,
  depositOfQuote,
  paymentTermsDays,
  paymentTermsDueDate,
  policyOfQuote,
  requestedDeposit,
  resolvePaymentPolicy,
  type PaymentPolicy,
} from "@/lib/payments-policy";
import { canResendBalanceInvoice } from "@/lib/payments/balance-resend";
import {
  canResendCommitmentInvoice,
  canResendDepositInvoice,
  type InvoiceResend,
} from "@/lib/payments/invoice-resend";
import { lateBalanceDueAtAcceptance } from "@/lib/payments/late-balance";
import { payInFullAvailable } from "@/lib/payments/pay-in-full";
import { legacyLocked } from "@/lib/legacy";
import { parseHeld, retainedPenceFor } from "@/lib/refunds/queue-view";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  balanceDue,
  balanceDueDate,
  balanceReference,
  commitmentReference,
  depositReference,
  isAcceptExpired,
  moveDateLabel,
  round2,
} from "@/lib/quote/payments";
import {
  chaseTextToHtml,
  depositChaseEmail,
  depositLabel,
  expiryLabelFrom,
  replyAddressFor,
} from "@/lib/quote/chase";
import {
  type LedgerProvider,
  asProvider,
  configuredProvider,
  createInvoice,
  findInvoiceByReference,
  findOrCreateContact,
  partyForQuote,
  getInvoicePdfBase64,
  getInvoiceStatus,
  recordInvoicePayment,
  reusableContactId,
  voidInvoice,
} from "@/lib/ledger";
// Provider-neutral, and NOT `isZohoAccessDenied` from @/lib/zoho: since gate 17
// this file's errors arrive as LedgerError, and that function opens by
// rejecting anything that is not a ZohoError. See lib/ledger/access.ts.
import { isLedgerAccessDenied } from "@/lib/ledger/access";
import { reportZohoAccessDenied, resolveZohoAccessDenied } from "@/lib/ops/zoho-access";
import { reportInvoiceRaiseFailed, resolveInvoiceRaiseFailed } from "@/lib/ops/invoice-raise";

type Sb = SupabaseClient<Database>;

/**
 * The payment policy to freeze onto a quote at acceptance (multi-brand PRD
 * §3.10, gate 8). Read once, here, and written into the same UPDATE that marks
 * the quote accepted — never re-derived afterwards, so a later edit to the
 * client's type cannot rewrite the schedule of a booking already in flight.
 *
 * BOTH accept paths call this: the customer's own acceptance at /q, and the
 * office accepting on their behalf. A snapshot written on only one of them is
 * worse than no snapshot at all, because the missing rows are indistinguishable
 * from genuinely-residential ones.
 *
 * A failed read resolves residential — the safe direction, since residential
 * collects up front — but it is LOGGED rather than swallowed. "The client is
 * residential" and "I could not find out what the client is" must not share a
 * silent rendering, and this is a money decision.
 */
export async function snapshotPaymentPolicy(
  sb: Sb,
  quote: { id: string; client_id: string | null; lead_id: string | null },
): Promise<PaymentPolicy> {
  // The quote's OWN client is the right source — the policy belongs to the
  // client this quote is for. The lead is only a fallback for a quote that
  // carries no client of its own; elsewhere in this file the order is reversed
  // (`lead?.client_id ?? quote.client_id`) because those call sites are
  // resolving who to invoice, which is a different question. Neither shape
  // exists in production today (both counts were 0 on 2026-08-28), but a client
  // merge is exactly the operation that would create one.
  let clientId = quote.client_id;
  if (!clientId && quote.lead_id) {
    const { data: lead } = await sb.from("leads").select("client_id").eq("id", quote.lead_id).maybeSingle();
    clientId = lead?.client_id ?? null;
  }
  if (!clientId) return "residential";

  const { data, error } = await sb.from("clients").select("is_company").eq("id", clientId).maybeSingle();
  if (error || !data) {
    log.warn("quote.payment_policy.client_unreadable", {
      quoteId: quote.id,
      clientId,
      reason: error ? error.message : "no client row",
      fellBackTo: "residential",
    });
    return "residential";
  }
  return resolvePaymentPolicy(data);
}

/**
 * The client's agreed payment terms in days, for dating a commercial invoice.
 *
 * Resolves the client the SAME way `snapshotPaymentPolicy` does — the quote's
 * own client first, the lead's only as a fallback — so the terms and the policy
 * can never be read off two different clients and produce an invoice dated on
 * somebody else's account.
 *
 * An unreadable client falls back to the 30-day default rather than blocking
 * the raise: refusing to invoice a completed job because a client row would not
 * load is the worse failure, and 30 is the SHORTER of the two allowed terms, so
 * the fallback can never extend credit nobody agreed to.
 */
async function clientPaymentTermsDays(
  sb: Sb,
  quote: { client_id: string | null; lead_id: string | null },
): Promise<number> {
  let clientId = quote.client_id;
  if (!clientId && quote.lead_id) {
    const { data: lead } = await sb.from("leads").select("client_id").eq("id", quote.lead_id).maybeSingle();
    clientId = lead?.client_id ?? null;
  }
  if (!clientId) return DEFAULT_PAYMENT_TERMS_DAYS;
  const { data } = await sb
    .from("clients")
    .select("payment_terms_days")
    .eq("id", clientId)
    .maybeSingle();
  return paymentTermsDays(data?.payment_terms_days);
}

const FUNNEL = ["website_enquiry", "survey_booked", "quoted", "provisional", "confirmed", "completed"];

const QUOTE_COLS =
  "id, quote_ref, status, source, brand, payment_policy, standard_comms_at, lead_id, client_id, estimator_id, customer_name, customer_email, customer_phone, collect_addr, dest_addr, moving_date, vat_enabled, grand_total, agreed_price, accepted_at, accept_token, accepted_name, created_at, email_sent_at, deposit_amount, deposit_paid_at, deposit_paid_method, deposit_selfreport_at, declined_at, zoho_contact_id, contact_provider, deposit_invoice_provider, balance_invoice_provider, commitment_invoice_provider, zoho_deposit_invoice_id, zoho_deposit_invoice_number, zoho_deposit_invoice_url, zoho_deposit_error, zoho_balance_invoice_id, zoho_balance_invoice_number, zoho_balance_invoice_url, balance_invoice_amount, balance_invoice_created_at, zoho_commitment_invoice_id, zoho_commitment_invoice_number, zoho_commitment_invoice_url, zoho_commitment_error, commitment_invoice_amount, commitment_invoice_created_at, commitment_due_date, commitment_paid_at, commitment_paid_method, commitment_chase_t10_at, date_releasable_at, booking_cancelled_at, po_number";

export type AcceptQuoteRow = {
  id: string;
  quote_ref: string;
  status: string;
  source: string;
  /** Brand slug (multi-brand PRD §3.1) — every customer send resolves its
   *  copy, From and template set from this, once per send. */
  brand: string;
  standard_comms_at: string | null;
  lead_id: string | null;
  client_id: string | null;
  estimator_id: string | null;
  customer_name: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  collect_addr: string | null;
  dest_addr: string | null;
  moving_date: string | null;
  vat_enabled: boolean;
  grand_total: number;
  agreed_price: number | null;
  accepted_at: string | null;
  accept_token: string | null;
  accepted_name: string | null;
  created_at: string;
  email_sent_at: string | null;
  deposit_amount: number | null;
  deposit_paid_at: string | null;
  deposit_paid_method: string | null;
  deposit_selfreport_at: string | null;
  declined_at: string | null;
  zoho_contact_id: string | null;
  /* Which ledger minted each stored id (migration 0109). Never infer these
     from a date or from each other: a booking accepted before the cutover
     takes its deposit in one system and its balance in the other, and the
     supersede path copies a deposit id onto a newer quote. */
  contact_provider: string | null;
  deposit_invoice_provider: string | null;
  balance_invoice_provider: string | null;
  commitment_invoice_provider: string | null;
  zoho_deposit_invoice_id: string | null;
  /** The policy snapshotted at acceptance (gate 8). Read here so the money
   *  rungs can refuse a policy they do not belong to - notably the DEPOSIT
   *  rung, which commercial does not have. */
  payment_policy: string | null;
  zoho_deposit_invoice_number: string | null;
  zoho_deposit_invoice_url: string | null;
  zoho_deposit_error: string | null;
  zoho_balance_invoice_id: string | null;
  zoho_balance_invoice_number: string | null;
  zoho_balance_invoice_url: string | null;
  balance_invoice_amount: number | null;
  balance_invoice_created_at: string | null;
  zoho_commitment_invoice_id: string | null;
  zoho_commitment_invoice_number: string | null;
  zoho_commitment_invoice_url: string | null;
  zoho_commitment_error: string | null;
  commitment_invoice_amount: number | null;
  commitment_invoice_created_at: string | null;
  commitment_due_date: string | null;
  commitment_paid_at: string | null;
  commitment_paid_method: string | null;
  commitment_chase_t10_at: string | null;
  date_releasable_at: string | null;
  /** Stamped when the booking behind this accepted quote was cancelled (Marley
   *  cancel / mark-lost). Money surfaces must go quiet: no payment panels on
   *  /q, no date confirmation, no commitment invoice, no chases. */
  booking_cancelled_at: string | null;
  /** Commercial only: the client's own purchase-order reference, printed on
   *  the completion invoice when present (PRD §3.10). Never required. */
  po_number?: string | null;
};

/** A real Zoho id (not unset, not a creation claim in flight). */
/** A Zoho id that actually exists — 'pending' is the CAS claim, not an invoice. */
export const isRealZohoId = (v: string | null): v is string => !!v && v !== "pending";

export async function fetchQuoteByToken(sb: Sb, token: string): Promise<AcceptQuoteRow | null> {
  if (!token || token.length < 10) return null;
  const { data } = await sb.from("quotes").select(QUOTE_COLS).eq("accept_token", token).maybeSingle();
  return (data as AcceptQuoteRow | null) ?? null;
}

export async function fetchQuoteById(sb: Sb, id: string): Promise<AcceptQuoteRow | null> {
  const { data } = await sb.from("quotes").select(QUOTE_COLS).eq("id", id).maybeSingle();
  return (data as AcceptQuoteRow | null) ?? null;
}

/* ---------------------------------------------------------- invoice re-send */

/** The rails an already-raised invoice can be sent again on. The balance rail
 *  has its own flow (its paid flag lives on the lead, and its email carries the
 *  Zoho PDF), so it keeps resendBalanceInvoiceFlow. */
export type ResendRail = "deposit" | "commitment";

/**
 * Gather the paid state from the database and answer the pure guard — ONE
 * decision, used by the flow that sends and by the dialog that offers to, so
 * the button and the server can never refuse on different grounds.
 *
 * Reading the paid flag afresh (rather than trusting the row already fetched)
 * is the point: a query ERROR must answer "could not check", never "unpaid".
 * fetchQuoteById swallows its error and returns null, which the callers report
 * as "Quote not found" — true enough for a missing row, and a lie for a failed
 * read, so neither rail leans on it for the money answer.
 */
export async function canResendInvoiceNow(
  sb: Sb,
  quote: AcceptQuoteRow,
  rail: ResendRail,
): Promise<InvoiceResend> {
  const shared = {
    bookingCancelled: !!quote.booking_cancelled_at,
    hasCustomerEmail: !!quote.customer_email,
    commsLocked: legacyLocked(quote),
  };

  if (rail === "deposit") {
    // Two copies of "the deposit is paid" exist and can diverge: markDepositPaid
    // stamps the quote then patches the lead (a failure there only raises an ops
    // alert), and the lead payments card can stamp the lead alone when no quote
    // owned the payment. EITHER saying paid is enough to refuse — the safe
    // direction — and a failed read of the lead copy answers "could not check".
    let depositPaid = !!quote.deposit_paid_at;
    let paidStateUnknown = false;
    if (quote.lead_id) {
      const { data: lead, error } = await sb
        .from("leads")
        .select("deposit_paid_at")
        .eq("id", quote.lead_id)
        .maybeSingle();
      if (error) paidStateUnknown = true;
      else depositPaid = depositPaid || !!lead?.deposit_paid_at;
    }
    return canResendDepositInvoice({
      ...shared,
      invoiceRaised: isRealZohoId(quote.zoho_deposit_invoice_id),
      invoicedAmount: Number(quote.deposit_amount ?? 0),
      depositPaid,
      paidStateUnknown,
    });
  }

  const { data: fresh, error } = await sb
    .from("quotes")
    .select("commitment_paid_at")
    .eq("id", quote.id)
    .maybeSingle();
  return canResendCommitmentInvoice({
    ...shared,
    invoiceRaised: isRealZohoId(quote.zoho_commitment_invoice_id),
    invoicedAmount: Number(quote.commitment_invoice_amount ?? 0),
    commitmentPaid: !!quote.commitment_paid_at || !!fresh?.commitment_paid_at,
    paidStateUnknown: !!error,
  });
}

/* ------------------------------------------------------------- accept token */

export function generateAcceptToken(): string {
  return randomBytes(18).toString("base64url"); // 24 url-safe chars
}

/** Idempotently give a quote its accept token (created lazily when the quote
 *  detail page first renders, so the PDF QR + email link always have a URL). */
export async function ensureAcceptToken(sb: Sb, quoteId: string): Promise<string | null> {
  const { data: q } = await sb.from("quotes").select("accept_token").eq("id", quoteId).maybeSingle();
  if (!q) return null;
  if (q.accept_token) return q.accept_token as string;
  const token = generateAcceptToken();
  // Conditional write — a concurrent tab may have won; re-read on miss.
  const { data: claimed } = await sb
    .from("quotes")
    .update({ accept_token: token } as never)
    .eq("id", quoteId)
    .is("accept_token", null)
    .select("accept_token");
  if (claimed?.length) return token;
  const { data: again } = await sb.from("quotes").select("accept_token").eq("id", quoteId).maybeSingle();
  return (again?.accept_token as string | null) ?? null;
}

export function acceptUrlFor(token: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL || "https://ops.marleymoves.co.uk";
  return `${base.replace(/\/$/, "")}/q/${token}`;
}

/* ------------------------------------------------------------- supersede */

interface SupersedeResult {
  /** The old accepted quote's deposit was already PAID — its payment record was
   *  carried onto the new quote, so no new deposit is requested or invoiced. */
  carriedDeposit: boolean;
}

/**
 * Accepting a quote retires its siblings — this is the price-revision path
 * (survey found more, re-quote, accept the new number) made safe:
 *
 *  - Other SENT quotes on the lead → superseded (their accept links die).
 *  - A previously ACCEPTED quote → superseded, and its money moves with it:
 *      deposit PAID   → the payment (and its Zoho invoice link) is carried onto
 *                       the new quote — never a second deposit invoice.
 *      deposit UNPAID → its Zoho deposit invoice is VOIDED (stays on the books
 *                       as void); the new quote raises its own.
 *      balance UNPAID invoice → voided; the new quote re-raises at the new price.
 *      balance PAID → hands off to a human (ops alert) — money already settled
 *                     against the old number is never touched from code.
 */
async function supersedeSiblingQuotes(
  sb: Sb,
  quote: AcceptQuoteRow,
  actorId: string | null,
): Promise<SupersedeResult> {
  const result: SupersedeResult = { carriedDeposit: false };
  if (!quote.lead_id) return result;

  const { data: siblings } = await sb
    .from("quotes")
    .select(QUOTE_COLS)
    .eq("lead_id", quote.lead_id)
    .neq("id", quote.id)
    .in("status", ["sent", "accepted"]);
  if (!siblings?.length) return result;

  const { data: lead } = await sb
    .from("leads")
    .select("balance_paid_at, client_id")
    .eq("id", quote.lead_id)
    .maybeSingle();

  for (const raw of siblings as AcceptQuoteRow[]) {
    const old = raw;
    await sb.from("quotes").update({ status: "superseded" } as never).eq("id", old.id);

    if (old.status !== "accepted") {
      await sb.from("activities").insert({
        lead_id: quote.lead_id,
        client_id: lead?.client_id ?? quote.client_id,
        actor_id: actorId,
        type: "note",
        summary: `Quote ${old.quote_ref} superseded by ${quote.quote_ref}`,
        meta: { superseded_quote_id: old.id, by_quote_id: quote.id },
      });
      continue;
    }

    // --- previously accepted: move the money to the new quote ---
    if (old.deposit_paid_at) {
      // Deposit already paid: carry the payment + invoice link across so the
      // balance math (agreed − deposit) and Zoho stay consistent. VAT rule:
      // never a second deposit invoice.
      await sb
        .from("quotes")
        .update({
          deposit_amount: old.deposit_amount,
          deposit_paid_at: old.deposit_paid_at,
          deposit_paid_method: old.deposit_paid_method,
          zoho_contact_id: old.zoho_contact_id,
          // The stamps travel with the ids (0109). This path is exactly why a
          // per-QUOTE provider marker is insufficient: it puts a document the
          // old system minted onto a quote created after the cutover.
          contact_provider: old.contact_provider,
          deposit_invoice_provider: old.deposit_invoice_provider,
          zoho_deposit_invoice_id: old.zoho_deposit_invoice_id,
          zoho_deposit_invoice_number: old.zoho_deposit_invoice_number,
          zoho_deposit_invoice_url: old.zoho_deposit_invoice_url,
        } as never)
        .eq("id", quote.id);
      result.carriedDeposit = true;
    } else if (isRealZohoId(old.zoho_deposit_invoice_id)) {
      // Unpaid deposit invoice on the old number: void it (audit stays in Zoho).
      try {
        await voidInvoice(old.zoho_deposit_invoice_id, asProvider(old.deposit_invoice_provider));
        await sb.from("activities").insert({
          lead_id: quote.lead_id,
          client_id: lead?.client_id ?? quote.client_id,
          actor_id: actorId,
          type: "note",
          summary: `Deposit invoice ${old.zoho_deposit_invoice_number ?? ""} voided — quote ${old.quote_ref} superseded`.trim(),
          meta: { superseded_quote_id: old.id, invoice_id: old.zoho_deposit_invoice_id },
        });
      } catch (err) {
        await sendOpsAlert(`Void deposit invoice FAILED — ${old.quote_ref}`, [
          `${old.quote_ref} was superseded by ${quote.quote_ref}, but voiding its unpaid deposit invoice ${old.zoho_deposit_invoice_number ?? ""} failed: ${err instanceof Error ? err.message : "unknown"}.`,
          `Void it manually in Zoho — the new quote raises its own deposit invoice.`,
        ], "system");
      }
    }

    // Commitment invoice (Payments Policy v2): the amount is 25% of the OLD
    // gross, so it can't carry onto a re-priced quote.
    //   unpaid → void it; the new quote re-raises at its own price the next
    //            time the confirmation self-heal runs (the lead stays
    //            date-confirmed — that flag lives on the lead, not the quote).
    //   PAID   → money already settled against the old number is never touched
    //            from code (deferred by design): alert a human to adjust the
    //            commitment position manually in Zoho.
    if (isRealZohoId(old.zoho_commitment_invoice_id)) {
      if (old.commitment_paid_at) {
        await sendOpsAlert(`Superseded quote has a PAID commitment — ${old.quote_ref}`, [
          `${old.quote_ref} was superseded by ${quote.quote_ref}, but its £${(old.commitment_invoice_amount ?? 0).toFixed(2)} commitment invoice ${old.zoho_commitment_invoice_number ?? ""} is already paid.`.replace(/\s+/g, " "),
          `Nothing was changed in Zoho — adjust the commitment invoice manually (the new quote's commitment is 25% of the NEW price).`,
        ], "money");
      } else {
        try {
          await voidInvoice(old.zoho_commitment_invoice_id, asProvider(old.commitment_invoice_provider));
          await sb.from("activities").insert({
            lead_id: quote.lead_id,
            client_id: lead?.client_id ?? quote.client_id,
            actor_id: actorId,
            type: "note",
            summary: `Commitment invoice ${old.zoho_commitment_invoice_number ?? ""} voided — quote ${old.quote_ref} superseded`.trim(),
            meta: { superseded_quote_id: old.id, invoice_id: old.zoho_commitment_invoice_id },
          });
        } catch (err) {
          await sendOpsAlert(`Void commitment invoice FAILED — ${old.quote_ref}`, [
            `${old.quote_ref} was superseded by ${quote.quote_ref}, but voiding its unpaid commitment invoice ${old.zoho_commitment_invoice_number ?? ""} failed: ${err instanceof Error ? err.message : "unknown"}.`,
            `Void it manually in Zoho — the new quote raises its own commitment invoice once confirmation self-heals.`,
          ], "system");
        }
      }
    }

    // Old balance invoice: re-raised at the new price, so retire the old one.
    if (isRealZohoId(old.zoho_balance_invoice_id)) {
      if (lead?.balance_paid_at) {
        await sendOpsAlert(`Superseded quote has a PAID balance — ${old.quote_ref}`, [
          `${old.quote_ref} was superseded by ${quote.quote_ref}, but its balance invoice ${old.zoho_balance_invoice_number ?? ""} is already paid.`,
          `Nothing was changed in Zoho — settle the price difference manually (credit note or extra invoice).`,
        ], "money");
      } else {
        try {
          await voidInvoice(old.zoho_balance_invoice_id, asProvider(old.balance_invoice_provider));
          await sb
            .from("leads")
            .update({ balance_amount: null, balance_due_date: null } as never)
            .eq("id", quote.lead_id);
          await sb
            .from("follow_ups")
            .update({ status: "cancelled", outcome: "cancelled" })
            .eq("lead_id", quote.lead_id)
            .eq("reason", "balance")
            .eq("status", "open");
          await sb.from("activities").insert({
            lead_id: quote.lead_id,
            client_id: lead?.client_id ?? quote.client_id,
            actor_id: actorId,
            type: "note",
            summary: `Balance invoice ${old.zoho_balance_invoice_number ?? ""} voided — re-raise it from ${quote.quote_ref} at the new price`.trim(),
            meta: { superseded_quote_id: old.id, invoice_id: old.zoho_balance_invoice_id },
          });
        } catch (err) {
          await sendOpsAlert(`Void balance invoice FAILED — ${old.quote_ref}`, [
            `${old.quote_ref} was superseded by ${quote.quote_ref}, but voiding its balance invoice failed: ${err instanceof Error ? err.message : "unknown"}. Void it manually in Zoho.`,
          ], "system");
        }
      }
    }

    await sb.from("activities").insert({
      lead_id: quote.lead_id,
      client_id: lead?.client_id ?? quote.client_id,
      actor_id: actorId,
      type: "status_change",
      summary: `Price revised: quote ${old.quote_ref} (£${(old.agreed_price ?? 0).toFixed(0)}) superseded by ${quote.quote_ref}${result.carriedDeposit ? " — paid deposit carried over" : ""}`,
      meta: { superseded_quote_id: old.id, by_quote_id: quote.id, carried_deposit: result.carriedDeposit },
    });
  }

  return result;
}

/**
 * Guard for adopting an ORPHAN Zoho invoice found by reference.
 *
 * Adoption exists for crash recovery: we created the invoice in Zoho, died
 * before writing the id back, and on the next pass find it again. But the same
 * lookup also finds an invoice a HUMAN raised under that reference — and Connor
 * works in Zoho directly. Adopting that verbatim silently binds our record to a
 * different number: the panel records what it computed while the customer gets
 * the other figure on the PDF, and whichever they pay leaves one system wrong.
 *
 * findInvoiceByReference returns the document total precisely so adopters can
 * check (its own comment says "never adopt a mismatch"); the storage biller does
 * this via classifyPendingClaim, and the three quote-money adopters did not.
 * Missing total = adopt (older Zoho payloads omit it; refusing would strand a
 * genuine crash-recovery orphan).
 */
export function adoptedInvoiceMatches(zohoTotal: number | undefined, expected: number): boolean {
  if (typeof zohoTotal !== "number" || Number.isNaN(zohoTotal)) return true;
  return Math.abs(zohoTotal - expected) <= 0.005;
}

/* ------------------------------------------------------------- accept */

/**
 * Acceptance ends the pre-sale conversation, so every task that only existed to
 * get the customer to this point is moot the moment they say yes:
 *
 *   quote_followup            the survey's "build and send the quote" reminder,
 *                             a chase-engine call task, a manual chase
 *   custom/inbound_reply      "customer replied to a chase email — respond"
 *   no_answer                 "we rang, no answer" retries
 *
 * Close them here or they sit on /follow-ups going overdue for customers who
 * have already booked, and inflate the dashboard overdue count, the estimator's
 * "My day" list and the weekly digest with them (Peter caught the quote_followup
 * case on the live board, 2026-08-07: Alina's card told Connor to "build and
 * send" a quote she'd been sent the day before).
 *
 * Money tasks are deliberately NOT in this set — a deposit or balance card
 * closes when the money lands, not when the customer accepts.
 */
export async function closeOpenQuoteFollowUps(sb: Sb, leadId: string): Promise<void> {
  const { data: open, error } = await sb
    .from("follow_ups")
    .select("id, reason, source")
    .eq("lead_id", leadId)
    .eq("status", "open")
    .in("reason", ["quote_followup", "no_answer", "custom"]);
  if (error) {
    log.error("followups.close_presale.query_failed", { leadId, error: error.message });
    return;
  }
  for (const fu of open ?? []) {
    // 'custom' carries several unrelated machine-raised tasks (commitment
    // chases, refund decisions, money alerts). Only the inbound-reply nudge is
    // answered by acceptance.
    if (fu.reason === "custom" && fu.source !== "inbound_reply") continue;
    await sb.from("follow_ups").update({ status: "cancelled", outcome: "cancelled" }).eq("id", fu.id);
  }
}

export type AcceptOutcome =
  | { ok: true; alreadyAccepted: boolean }
  | { ok: false; error: string };

/**
 * Customer accepts online: stamp the quote (agreed price = quoted total),
 * advance the lead to PROVISIONAL, open the deposit chase, raise the deposit
 * invoice in Zoho (fail-soft), and alert ops. Safe to call twice — a repeat
 * accept is a no-op that still self-heals a missing deposit invoice.
 */
export async function acceptQuoteOnline(
  sb: Sb,
  token: string,
  fullName: string,
  ip: string | null,
  opts?: { acks?: Record<string, unknown>; userAgent?: string | null; signatureImage?: string | null },
): Promise<AcceptOutcome> {
  const quote = await fetchQuoteByToken(sb, token);
  if (!quote) return { ok: false, error: "This quote link is no longer valid." };
  if (quote.status === "accepted") {
    // Never create money side effects for an accepted row that is missing its
    // contract evidence (for example, a prior partial failure).
    const { data: signature } = await sb
      .from("signatures")
      .select("id")
      .eq("quote_id", quote.id)
      .eq("kind", "contract")
      .limit(1)
      .maybeSingle();
    if (!signature) return { ok: false, error: "We couldn't verify the acceptance record — please call 01747 637070." };
    await ensureDepositInvoice(sb, quote.id); // self-heal, then treat as success
    await ensureLateBookingBalanceInvoice(sb, quote.id, null);
    return { ok: true, alreadyAccepted: true };
  }
  if (quote.status !== "sent") return { ok: false, error: "This quote link is no longer valid." };
  if (isAcceptExpired(quote.email_sent_at, quote.created_at)) {
    return { ok: false, error: "This quote has expired. Call us on 01747 637070 for an updated price." };
  }
  const name = fullName.trim().slice(0, 120);
  if (name.length < 2) return { ok: false, error: "Type your full name to accept the quote." };
  if (!allAcksConfirmed(opts?.acks)) {
    return { ok: false, error: "Please tick each confirmation box to accept the quote." };
  }

  const settings = await getBusinessSettings(sb);
  const agreed = quote.agreed_price ?? Number(quote.grand_total ?? 0);
  // Late-booking collapse: a move inside 7 days is invoiced the full 25% as
  // ONE up-front payment (requestedDeposit), so the commitment machinery never
  // engages — no second invoice minutes later, no chase, no at-risk alarm.
  const deposit = requestedDeposit(
    agreed,
    quote.deposit_amount ?? settings.defaultDeposit,
    quote.moving_date,
    settings.smallJobThreshold,
  );

  const acceptedAt = new Date().toISOString();
  const paymentPolicy = await snapshotPaymentPolicy(sb, quote);
  // A COMMERCIAL quote is never self-accepted (PRD §3.10): it renders on /q
  // for review and the office confirms it. Refused HERE, on the server, and
  // not merely hidden on the page - a hidden button is not a closed door,
  // and this action is reachable by anyone holding the token.
  //
  // What the hole would cost: the row would take status='accepted' with
  // payment_policy='commercial', and the very next line raises a DEPOSIT
  // invoice - a rung commercial does not have. The customer would hold a
  // -DEP invoice nobody meant to send, on a booking the office had not
  // confirmed.
  //
  // Resolved from the same snapshot the write uses, so the page and the
  // server can never disagree about which policy this quote is on.
  if (paymentPolicy === "commercial") {
    return {
      ok: false,
      error: "This quote is on business terms - we'll confirm it with you and invoice on your account.",
    };
  }
  const { data: won, error } = await sb
    .from("quotes")
    .update({
      status: "accepted",
      accepted_at: acceptedAt,
      accepted_name: name,
      accepted_ip: ip,
      agreed_price: agreed,
      deposit_amount: deposit,
      payment_policy: paymentPolicy,
    } as never)
    .eq("id", quote.id)
    .eq("status", "sent") // double-submit / accept-vs-decline race: only one wins
    .select("id");
  if (error) return { ok: false, error: "Something went wrong — please call 01747 637070." };
  if (!won?.length) {
    const current = await fetchQuoteById(sb, quote.id);
    if (current?.status === "accepted") {
      const { data: signature } = await sb
        .from("signatures")
        .select("id")
        .eq("quote_id", quote.id)
        .eq("kind", "contract")
        .limit(1)
        .maybeSingle();
      if (signature) return { ok: true, alreadyAccepted: true };
      return { ok: false, error: "Your acceptance is still being saved — please wait a moment and refresh." };
    }
    return { ok: false, error: "This quote link is no longer valid." };
  }

  // The contract signature record — typed name + the acknowledgment set +
  // T&C version + IP/UA. One per quote (unique index); a replay just skips.
  // signatureImage = the client's script rendering of the typed name (nice
  // for certificates/office view); the typed name itself is the signature.
  const { error: signatureError } = await sb.from("signatures").insert({
    kind: "contract",
    quote_id: quote.id,
    lead_id: quote.lead_id,
    client_id: quote.client_id,
    signer_name: name,
    signature_data: isValidSignatureDataUri(opts?.signatureImage) ? opts?.signatureImage : null,
    method: "typed",
    channel: "remote",
    acknowledgments: normalizeAcks(opts?.acks),
    ...termsSnapshot("customer-terms"),
    ip,
    user_agent: opts?.userAgent ?? null,
  } as never);
  if (signatureError && signatureError.code !== "23505") {
    // Keep quote state and legal evidence together. The conditional rollback
    // cannot undo another later transition because it is bound to our stamp.
    const { data: rolledBack } = await sb
      .from("quotes")
      .update({
        status: "sent",
        accepted_at: null,
        accepted_name: null,
        accepted_ip: null,
        agreed_price: quote.agreed_price,
        deposit_amount: quote.deposit_amount,
      } as never)
      .eq("id", quote.id)
      .eq("status", "accepted")
      .eq("accepted_at", acceptedAt)
      .select("id");
    if (!rolledBack?.length) {
      await sendOpsAlert(`Acceptance evidence FAILED — ${quote.quote_ref}`, [
        `Quote <strong>${quote.quote_ref}</strong> was accepted but its signature record failed and the safe rollback did not win.`,
        `Do not request payment until the contract evidence is repaired.`,
      ], "system").catch(() => {});
    }
    return { ok: false, error: "We couldn't save the acceptance — please try again or call 01747 637070." };
  }

  // Retire sibling quotes (re-quote path): carries a paid deposit across,
  // voids an unpaid one — never two live deposit invoices on one lead.
  const { carriedDeposit } = await supersedeSiblingQuotes(sb, { ...quote, status: "accepted" }, null);

  if (quote.lead_id) {
    const { data: lead } = await sb
      .from("leads")
      .select("status, first_contacted_at, client_id")
      .eq("id", quote.lead_id)
      .single();
    const patch: Record<string, unknown> = carriedDeposit
      ? {} // deposit already paid on the superseded quote — no new request, no chase
      : {
          deposit_amount: deposit,
          deposit_requested_at: new Date().toISOString(),
          // Fresh chase context: acceptance ends the quote chase and arms the
          // deposit cadence, even if a reply had paused chasing earlier.
          chase_paused: false,
          deposit_chase_step: 0,
        };
    if (lead && FUNNEL.indexOf(lead.status) < FUNNEL.indexOf("provisional")) patch.status = "provisional";
    if (lead && !lead.first_contacted_at) patch.first_contacted_at = new Date().toISOString();
    if (Object.keys(patch).length) await sb.from("leads").update(patch as never).eq("id", quote.lead_id);

    await closeOpenQuoteFollowUps(sb, quote.lead_id);

    // One open deposit CALL task max — due day 5 (the chase engine emails
    // automatically on days 1 and 3, so the human only steps in after those).
    if (!carriedDeposit) {
      const { data: open } = await sb
        .from("follow_ups")
        .select("id")
        .eq("lead_id", quote.lead_id)
        .eq("reason", "deposit")
        .eq("status", "open")
        .limit(1)
        .maybeSingle();
      if (!open) {
        await sb.from("follow_ups").insert({
          lead_id: quote.lead_id,
          client_id: lead?.client_id ?? quote.client_id,
          quote_id: quote.id,
          reason: "deposit",
          due_at: ukTimeAt(9, 0, 5).toISOString(),
          assigned_to: quote.estimator_id,
          source: "online_accept",
          notes: "Deposit still unpaid after two automatic reminders — give them a call.",
          metadata: { amount: deposit },
        } as never);
      }
    }

    await sb.from("activities").insert({
      lead_id: quote.lead_id,
      client_id: lead?.client_id ?? quote.client_id,
      actor_id: null,
      type: "status_change",
      summary: `Quote ${quote.quote_ref} accepted ONLINE by "${name}" — agreed £${agreed.toFixed(0)}, ${carriedDeposit ? "deposit already paid (carried over)" : `£${deposit.toFixed(0)} deposit requested`}`,
      meta: { quote_id: quote.id, agreed_price: agreed, accepted_name: name, via: "accept_page" },
    });
  }

  if (!carriedDeposit) await ensureDepositInvoice(sb, quote.id);
  // Re-quote on an already date-confirmed lead (carried deposit): the old
  // quote's commitment was voided by the supersede, so raise this quote's own
  // commitment invoice at the NEW price. Self-guarded — no-op unless the lead
  // is confirmed and 25% x gross exceeds the deposit.
  await ensureCommitmentInvoice(sb, quote.id);
  // Move inside T-7: the balance is raised now rather than trailing from the
  // T-7 cron tomorrow (PRD §3.10 Addition 2). No-op for every other booking,
  // and for a small job whose ask already took the whole price.
  await ensureLateBookingBalanceInvoice(sb, quote.id, null);

  await sendOpsAlert(`Quote ${quote.quote_ref} accepted online`, [
    `<strong>${escapeHtml(quote.customer_name ?? "Customer")}</strong> accepted quote <strong>${quote.quote_ref}</strong> (signed "${escapeHtml(name)}").`,
    carriedDeposit
      ? `Agreed £${agreed.toFixed(2)} — their paid deposit was carried over from the superseded quote.`
      : `Agreed £${agreed.toFixed(2)} — £${deposit.toFixed(2)} deposit now requested.`,
    carriedDeposit
      ? `Lead stays Confirmed.`
      : `Lead moved to Provisional. It confirms automatically when the deposit lands.`,
  ]);

  return { ok: true, alreadyAccepted: false };
}

/* ------------------------------------------------------------- staff accept */

export type StaffAcceptOutcome =
  | { ok: true; alreadyAccepted: boolean; agreed: number; deposit: number; emailed: boolean }
  | { ok: false; error: string };

/**
 * Staff-side acceptance ("Mark accepted" / "Mark won" — the customer said yes
 * on the phone). Runs the SAME machine as the online accept page so both paths
 * are indistinguishable downstream: quote accepted at the agreed price, lead
 * PROVISIONAL (confirmed only when the deposit lands), deposit requested +
 * Zoho deposit invoice raised, day-5 call task queued, and the customer
 * emailed their payment link immediately (they are not on the accept page,
 * unlike the online path — the email IS their payment surface).
 */
export async function acceptQuoteByStaff(
  sb: Sb,
  quoteId: string,
  actorId: string | null,
  agreedPrice?: number,
  depositOverride?: number,
): Promise<StaffAcceptOutcome> {
  const quote = await fetchQuoteById(sb, quoteId);
  if (!quote) return { ok: false, error: "Quote not found" };
  const settings = await getBusinessSettings(sb);
  const baseDeposit =
    typeof depositOverride === "number" && Number.isFinite(depositOverride) && depositOverride > 0
      ? round2(depositOverride)
      : (quote.deposit_amount ?? settings.defaultDeposit);

  if (quote.status === "accepted") {
    await ensureDepositInvoice(sb, quote.id); // self-heal, then no-op
    await ensureLateBookingBalanceInvoice(sb, quote.id, actorId);
    return {
      ok: true,
      alreadyAccepted: true,
      agreed: quote.agreed_price ?? Number(quote.grand_total ?? 0),
      // The frozen truth, read through the policy so a commercial booking
      // reports the £0 it was actually asked for — including one accepted
      // before the branch below existed, whose row still carries a residential
      // figure it was never asked to pay.
      deposit: depositOfQuote(quote, settings.defaultDeposit),
      emailed: false,
    };
  }
  if (quote.status !== "draft" && quote.status !== "sent") {
    return { ok: false, error: `A ${quote.status} quote can't be accepted.` };
  }

  const agreed =
    typeof agreedPrice === "number" && Number.isFinite(agreedPrice) && agreedPrice > 0
      ? round2(agreedPrice)
      : (quote.agreed_price ?? Number(quote.grand_total ?? 0));
  // Which LADDER this booking runs, resolved BEFORE the ask is computed —
  // because on the commercial one there is no ask. Gate 10b closed the online
  // path to commercial quotes, so this function is the ONLY way one is ever
  // accepted, and everything below it here is residential machinery.
  const paymentPolicy = await snapshotPaymentPolicy(sb, quote);
  const commercial = paymentPolicy === "commercial";
  // Commercial takes NO deposit (PRD §3.10): one invoice raised on completion,
  // due on the client's own terms. `requestedDeposit` is the residential rule
  // and knows nothing of that, so running it here wrote a deposit the customer
  // was never asked for — and its own two collapses made the damage variable
  // rather than a flat £100. A £2,400 job reported £2,300; the same job four
  // days out reported £1,800 (the ask collapses to 25%); and at or under the
  // small-job threshold the ask IS the gross, so deposit_amount == agreed left
  // the only commercial money figure at exactly £0 — "£0 due" printed against a
  // live job nobody had paid a penny towards.
  //
  // Written as 0 rather than left null on purpose: every downstream read of this
  // column falls back to the Settings default when it is null, so null would
  // quietly restore the £100 at the first read (see `depositOfQuote`).
  //
  // Late-booking collapse (applies over an office-typed override too — the
  // returned/toasted deposit shows the real ask): a move inside 7 days takes
  // the full 25% up-front, so no commitment invoice ever raises for it.
  const deposit = commercial
    ? 0
    : requestedDeposit(agreed, baseDeposit, quote.moving_date, settings.smallJobThreshold);

  // The payment link (accept page in its post-accept state) + reply routing
  // both hang off the token — make sure it exists before anything sends.
  const token = quote.accept_token ?? (await ensureAcceptToken(sb, quote.id));

  const { data: won } = await sb
    .from("quotes")
    .update({
      status: "accepted",
      accepted_at: new Date().toISOString(),
      agreed_price: agreed,
      deposit_amount: deposit,
      payment_policy: paymentPolicy,
    } as never)
    .eq("id", quote.id)
    .in("status", ["draft", "sent"]) // double-tap / online-accept race: one winner
    .select("id");
  if (!won?.length) {
    await ensureDepositInvoice(sb, quote.id);
    await ensureLateBookingBalanceInvoice(sb, quote.id, actorId);
    return { ok: true, alreadyAccepted: true, agreed, deposit, emailed: false };
  }

  // Retire sibling quotes (re-quote path): carries a paid deposit across,
  // voids an unpaid one — never two live deposit invoices on one lead.
  const { carriedDeposit } = await supersedeSiblingQuotes(sb, { ...quote, status: "accepted" }, actorId);

  if (quote.lead_id) {
    const { data: lead } = await sb
      .from("leads")
      .select("status, first_contacted_at, client_id")
      .eq("id", quote.lead_id)
      .single();
    // Nothing was requested in either of these cases: the deposit came across
    // already paid on the superseded quote, or this is commercial and there is
    // no deposit rung to request. Stamping deposit_requested_at on a commercial
    // booking would date an ask that never happened, and arming the chase
    // counters would leave it primed for a queue it is excluded from.
    const patch: Record<string, unknown> = carriedDeposit || commercial
      ? {}
      : {
          deposit_amount: deposit,
          deposit_requested_at: new Date().toISOString(),
          chase_paused: false,
          deposit_chase_step: 0,
        };
    if (lead && FUNNEL.indexOf(lead.status) < FUNNEL.indexOf("provisional")) patch.status = "provisional";
    if (lead && !lead.first_contacted_at) patch.first_contacted_at = new Date().toISOString();
    if (Object.keys(patch).length) await sb.from("leads").update(patch as never).eq("id", quote.lead_id);

    await closeOpenQuoteFollowUps(sb, quote.lead_id);

    // One open deposit CALL task max — day 5, after the day-1/3 auto reminders.
    // Never for commercial: it would put "deposit still unpaid — give them a
    // call" in the follow-ups queue for a deposit that was never asked for, and
    // name the two automatic reminders commercial is excluded from.
    if (!carriedDeposit && !commercial) {
      const { data: open } = await sb
        .from("follow_ups")
        .select("id")
        .eq("lead_id", quote.lead_id)
        .eq("reason", "deposit")
        .eq("status", "open")
        .limit(1)
        .maybeSingle();
      if (!open) {
        await sb.from("follow_ups").insert({
          lead_id: quote.lead_id,
          client_id: lead?.client_id ?? quote.client_id,
          quote_id: quote.id,
          reason: "deposit",
          due_at: ukTimeAt(9, 0, 5).toISOString(),
          assigned_to: quote.estimator_id ?? actorId,
          created_by: actorId,
          source: "staff_accept",
          notes: "Deposit still unpaid after two automatic reminders — give them a call.",
          metadata: { amount: deposit },
        } as never);
      }
    }

    await sb.from("activities").insert({
      lead_id: quote.lead_id,
      client_id: lead?.client_id ?? quote.client_id,
      actor_id: actorId,
      type: "status_change",
      summary: `Quote ${quote.quote_ref} accepted — agreed £${agreed.toFixed(0)}, ${
        commercial
          ? "business terms — no deposit, invoiced on completion"
          : carriedDeposit
            ? "deposit already paid (carried over)"
            : `£${deposit.toFixed(0)} deposit requested`
      }`,
      meta: { quote_id: quote.id, agreed_price: agreed, via: "staff_accept" },
    });
  }

  if (carriedDeposit) {
    // Fully paid deposit came across with the supersede — nothing to invoice or
    // chase; the caller reports "price revised" rather than "deposit requested".
    // A date-confirmed lead still gets its commitment re-raised at the new
    // price (the supersede voided the old -COM; self-guarded no-op otherwise).
    await ensureCommitmentInvoice(sb, quote.id);
    await ensureLateBookingBalanceInvoice(sb, quote.id, actorId);
    return { ok: true, alreadyAccepted: false, agreed, deposit, emailed: false };
  }

  await ensureDepositInvoice(sb, quote.id);
  // Same rule as the online path, and today a no-op here BY DESIGN: office
  // 'Mark won' collects no customer signature, so a staff-accepted late
  // booking keeps waiting for the cron. See lib/payments/late-balance.ts.
  await ensureLateBookingBalanceInvoice(sb, quote.id, actorId);

  // Payment instructions to the customer, right now (dup-guarded). Reuses the
  // day-1 reminder copy — sending it here advances the chase to step 1 so the
  // engine's next touch is day 3.
  //
  // Never for commercial. This is the day-1 DEPOSIT CHASE email, and it names
  // the figure: before the fix above it asked a business client for the £100
  // (or 25%) they were never quoted, and after it the same email would ask them
  // for £0. Both are wrong, and both land in a real customer's inbox. A
  // commercial booking is confirmed by the office and hears from us next when
  // the completion invoice is raised.
  let emailed = false;
  if (!commercial && quote.customer_email && token) {
    emailed = await sendDepositRequestEmail(sb, actorId, quote, deposit, token);
    if (emailed && quote.lead_id) await stampDepositChaseStarted(sb, quote.lead_id);
  }

  return { ok: true, alreadyAccepted: false, agreed, deposit, emailed };
}

/* ------------------------------------------------------------- decline (customer) */

const DECLINE_REASONS = new Set([
  "too_expensive",
  "chose_competitor",
  "move_fell_through",
  "dates_didnt_work",
  "other",
]);

/**
 * Customer declines from the /q page — the quote is rejected, the lead is lost
 * with THEIR stated reason (feeds the Performance "why we lose" breakdown
 * without waiting for staff), and all chasing stops immediately.
 */
export async function declineQuoteOnline(
  sb: Sb,
  token: string,
  reason: string,
  note?: string,
): Promise<{ ok: boolean; error?: string }> {
  const quote = await fetchQuoteByToken(sb, token);
  if (!quote) return { ok: false, error: "This quote link is no longer valid." };
  if (quote.status === "rejected") return { ok: true };
  if (quote.status !== "sent") {
    return { ok: false, error: "This quote can't be declined online any more — call us on 01747 637070." };
  }
  const lostReason = DECLINE_REASONS.has(reason) ? reason : "other";

  const { data: won, error: declineError } = await sb
    .from("quotes")
    .update({
      status: "rejected",
      declined_at: new Date().toISOString(),
      declined_reason: lostReason,
    } as never)
    .eq("id", quote.id)
    .eq("status", "sent")
    .select("id");
  if (declineError) return { ok: false, error: "We couldn't save that — please try again." };
  if (!won?.length) {
    // Only report success when this or an identical decline won. If an accept
    // won the race, never tell the customer that their quote was declined.
    const current = await fetchQuoteById(sb, quote.id);
    if (current?.status === "rejected") return { ok: true };
    return { ok: false, error: "This quote can't be declined online any more — call us on 01747 637070." };
  }

  if (quote.lead_id) {
    await sb
      .from("leads")
      .update({
        status: "declined",
        lost_reason: lostReason,
        lost_note: note?.trim().slice(0, 2000) || null,
        lost_at: new Date().toISOString(),
        chase_paused: true,
      } as never)
      .eq("id", quote.lead_id);
    await sb
      .from("follow_ups")
      .update({ status: "cancelled", outcome: "declined" })
      .eq("lead_id", quote.lead_id)
      .eq("status", "open");
    await sb.from("activities").insert({
      lead_id: quote.lead_id,
      client_id: quote.client_id,
      actor_id: null,
      type: "status_change",
      summary: `Quote ${quote.quote_ref} declined ONLINE — ${lostReason.replace(/_/g, " ")}${note?.trim() ? ` ("${note.trim()}")` : ""}`,
      meta: { quote_id: quote.id, via: "accept_page", lost_reason: lostReason },
    });
  }

  await sendOpsAlert(`Quote ${quote.quote_ref} declined online`, [
    `<strong>${escapeHtml(quote.customer_name ?? "Customer")}</strong> declined quote <strong>${quote.quote_ref}</strong>.`,
    `Reason: ${lostReason.replace(/_/g, " ")}${note?.trim() ? ` — "${escapeHtml(note.trim())}"` : ""}.`,
    `Chasing stopped; the lead is marked lost with their reason.`,
  ]);

  return { ok: true };
}

/* ------------------------------------------------------------- deposit self-report */

/**
 * Customer taps "I've sent the bank transfer" on the payment page. Staff still
 * confirm against the bank — this just pauses the reminder emails and puts a
 * "check the bank" task at the top of the queue so the confirmation isn't
 * waiting on someone happening to notice the credit.
 */
export async function reportDepositSent(
  sb: Sb,
  token: string,
): Promise<{ ok: boolean; already?: boolean; error?: string }> {
  const quote = await fetchQuoteByToken(sb, token);
  if (!quote) return { ok: false, error: "This quote link is no longer valid." };
  if (quote.status !== "accepted" || quote.deposit_paid_at) return { ok: true, already: true };

  const { data: won } = await sb
    .from("quotes")
    .update({ deposit_selfreport_at: new Date().toISOString() } as never)
    .eq("id", quote.id)
    .is("deposit_selfreport_at", null)
    .select("id");
  if (!won?.length) return { ok: true, already: true };

  const settings = await getBusinessSettings(sb);
  const deposit = quote.deposit_amount ?? settings.defaultDeposit;

  if (quote.lead_id) {
    // Stop the reminder emails while the transfer is checked.
    await sb.from("leads").update({ chase_paused: true } as never).eq("id", quote.lead_id);

    const notes = `Customer says the £${deposit.toFixed(2)} deposit was sent by bank transfer (ref ${quote.quote_ref}) — check the bank and tap "Deposit received" in Bookings.`;
    const { data: open } = await sb
      .from("follow_ups")
      .select("id")
      .eq("lead_id", quote.lead_id)
      .eq("reason", "deposit")
      .eq("status", "open")
      .limit(1)
      .maybeSingle();
    if (open) {
      await sb.from("follow_ups").update({ due_at: new Date().toISOString(), notes }).eq("id", open.id);
    } else {
      await sb.from("follow_ups").insert({
        lead_id: quote.lead_id,
        client_id: quote.client_id,
        quote_id: quote.id,
        reason: "deposit",
        due_at: new Date().toISOString(),
        assigned_to: quote.estimator_id,
        source: "customer_selfreport",
        notes,
        metadata: { amount: deposit },
      } as never);
    }

    await sb.from("activities").insert({
      lead_id: quote.lead_id,
      client_id: quote.client_id,
      actor_id: null,
      type: "note",
      summary: `Customer reports the deposit transfer is sent (${quote.quote_ref}) — check the bank`,
      meta: { quote_id: quote.id, via: "accept_page" },
    });
  }

  await sendOpsAlert(`Customer says deposit sent — ${quote.quote_ref}`, [
    `<strong>${escapeHtml(quote.customer_name ?? "Customer")}</strong> reports the £${deposit.toFixed(2)} deposit for <strong>${quote.quote_ref}</strong> was sent by bank transfer.`,
    `Check the bank, then confirm it in Bookings — reminders are paused meanwhile.`,
  ], "money");

  return { ok: true };
}

/* ------------------------------------------------------------- deposit invoice */


/**
 * The "how to pay" sentence on a customer-visible invoice note.
 *
 * Two independent facts were conflated here until 2026-08-27: whether this is
 * the default brand (which decides the MarleyMoves Ltd disclosure, §3.5) and
 * whether the card channel is live (which decides the card mention, §11.10).
 * Keying both off the slug meant a brand could never be given card even with
 * its switch on, and the default brand could never have it taken away —
 * `brands.card_payments_enabled` was a dead control (QA-20260826-07).
 *
 * Both existing strings are reproduced byte-for-byte: Marley today has card on,
 * so it still reads "…(reference X), by card over the phone on 01747 637070, or
 * cash."; a card-off brand still reads "…(reference X) or cash." with no comma.
 * The `lead`/`tail` split keeps the two invoice notes' differing wording without
 * duplicating this logic.
 */
export function invoicePayClause(brand: Brand, quoteRef: string, lead: string): string {
  const phone = (brand.phone ?? "").trim() || "01747 637070";
  // The default brand's wording is LITERAL, matching `emailTheme` — its own row
  // flag governs neither, so Marley's invoice note cannot change because a row
  // read went stale. Marley's Settings toggle therefore stays advisory: the
  // known remainder of QA-20260826-07, flagged for Peter rather than resolved by
  // quietly loosening the byte-lock in `email-brand.test.ts`.
  const cardOn = brand.slug === DEFAULT_BRAND || brand.cardPaymentsEnabled;
  const card = cardOn ? `, by card over the phone on ${phone}` : "";
  const bank = card
    ? `${lead} bank transfer (reference ${quoteRef})${card}, or cash.`
    : `${lead} bank transfer (reference ${quoteRef}) or cash.`;
  if (brand.slug === DEFAULT_BRAND) return bank;
  return (
    `${bank} ${brand.name} is part of MarleyMoves Ltd, so your payment goes to the ` +
    `MARLEYMOVES LTD account. Please use reference ${quoteRef} so we can match it to your booking.`
  );
}

/**
 * Raise the £deposit invoice in Zoho exactly once. Returns the (possibly
 * pre-existing) invoice fields, or null when creation is impossible right now
 * (claim held elsewhere / Zoho down) — callers re-invoke later, it self-heals.
 */
export async function ensureDepositInvoice(sb: Sb, quoteId: string): Promise<AcceptQuoteRow | null> {
  const quote = await fetchQuoteById(sb, quoteId);
  if (!quote || quote.status !== "accepted") return quote;
  // COMMERCIAL has no deposit rung at all (PRD §3.10) - one invoice on the
  // client's own terms, and nothing up front.
  //
  // This guard is load-bearing rather than tidy. Unlike ensureCommitmentInvoice
  // (which carries legacyLocked, booking_cancelled_at, the MMR020 balance guard
  // and `if (amount <= 0) return quote`), this function has only ever gated on
  // status and an existing id. A commercial quote has neither a deposit amount
  // nor an id, so it would sail through, and `0 ?? defaultDeposit` is 0 under
  // nullish coalescing - meaning the ledger would create AND SEND a real GBP 0
  // invoice to a commercial customer. Both adapters do it without complaint.
  //
  // Placed BEFORE the CAS claim on purpose: claiming first and refusing after
  // would leave zoho_deposit_invoice_id stuck on 'pending', which every other
  // caller reads as "another writer holds this slot" and backs off from
  // forever.
  if (quote.payment_policy === "commercial") return quote;
  if (isRealZohoId(quote.zoho_deposit_invoice_id)) return quote;

  // Which ledger this raise talks to. Read ONCE per raise and written to the
  // row alongside every id it produces, so a later status poll routes to the
  // system that actually minted the document rather than to whatever the env
  // says today (0109).
  const ledger: LedgerProvider = configuredProvider();
  // Claim the creation slot: NULL → 'pending'. Only one caller wins.
  const { data: claimed } = await sb
    .from("quotes")
    .update({ zoho_deposit_invoice_id: "pending", deposit_invoice_provider: ledger } as never)
    .eq("id", quoteId)
    .is("zoho_deposit_invoice_id", null)
    .select("id");
  if (!claimed?.length) return quote; // another caller is on it (or just finished)

  const settings = await getBusinessSettings(sb);
  const deposit = quote.deposit_amount ?? settings.defaultDeposit;
  const ref = depositReference(quote.quote_ref);
  try {
    // Crash-recovery: adopt an orphan created on a previous attempt.
    let inv = await findInvoiceByReference(ref);
    if (inv && !adoptedInvoiceMatches(inv.total, deposit)) {
      // An invoice under this reference that bills a DIFFERENT figure was not
      // created by our crashed run — it is Connor's, raised by hand in Zoho.
      // Adopting it binds our record to his number while the customer holds his
      // PDF, so whichever they pay leaves one system wrong. Release and alert.
      await sb
        .from("quotes")
        .update({ zoho_deposit_invoice_id: null } as never)
        .eq("id", quoteId)
        .eq("zoho_deposit_invoice_id", "pending");
      await sendOpsAlert(`Deposit invoice NOT adopted — figure mismatch (${quote.quote_ref})`, [
        `An invoice already exists in Zoho under reference <strong>${ref}</strong> for £${(inv.total ?? 0).toFixed(2)}, but ops computed £${deposit.toFixed(2)}.`,
        `It was NOT adopted. Reconcile ${inv.invoiceNumber} in Zoho (void it, or correct the figure), then retry.`,
      ], "money").catch(() => {});
      return quote;
    }
    let contactId = quote.zoho_contact_id;
    let contactProvider = quote.contact_provider;
    if (!inv) {
      // A contact id is reusable only inside the ledger that minted it (0109).
      if (!reusableContactId(contactId, contactProvider, ledger)) {
        contactId = await findOrCreateContact({
          name: quote.customer_name ?? "Customer",
          email: quote.customer_email,
          phone: quote.customer_phone,
          // Keyed on the client, not the name: Xero rejects (or worse, silently
          // adopts) a duplicate contact name. `partyForQuote` logs if it has to
          // fall back to the quote id.
          party: partyForQuote({ id: quote.id, clientId: quote.client_id }),
        });
        contactProvider = ledger;
      }
      inv = await createInvoice({
        customerId: contactId!,
        reference: ref,
        description: `Booking deposit — removal quote ${quote.quote_ref}`,
        amount: round2(deposit),
        notes: `Deposit to secure your move date. Quote ${quote.quote_ref}. The balance is invoiced separately before move day.`,
      });
    }
    await sb
      .from("quotes")
      .update({
        zoho_contact_id: contactId,
        contact_provider: contactProvider,
        zoho_deposit_invoice_id: inv.invoiceId,
        deposit_invoice_provider: ledger,
        zoho_deposit_invoice_number: inv.invoiceNumber,
        zoho_deposit_invoice_url: inv.invoiceUrl,
        zoho_deposit_error: null,
      } as never)
      .eq("id", quoteId);
    await resolveZohoAccessDenied(sb);
    await resolveInvoiceRaiseFailed(sb);
    return await fetchQuoteById(sb, quoteId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Zoho deposit invoice failed";
    // Release the claim so the next page view / cron pass retries.
    await sb
      .from("quotes")
      .update({ zoho_deposit_invoice_id: null, zoho_deposit_error: msg } as never)
      .eq("id", quoteId)
      .eq("zoho_deposit_invoice_id", "pending");
    // A lock-out is not this quote's problem — it is every quote's. Collapse it
    // into the one integration-level alert that names the actual remedy.
    if (isLedgerAccessDenied(err)) await reportZohoAccessDenied(sb, { message: msg, while: "deposit invoice" });
    else {
      // The email alone left no trace anywhere a human looks: the ops board and
      // the daily digest read clean while the customer went unbilled.
      await reportInvoiceRaiseFailed(sb, { message: msg, kind: "deposit", quoteRef: quote.quote_ref, reference: ref });
      await sendOpsAlert(`Zoho deposit invoice FAILED — ${quote.quote_ref}`, [
        `Creating the £${deposit.toFixed(2)} deposit invoice for <strong>${quote.quote_ref}</strong> failed: ${msg}`,
        `The acceptance itself is recorded; the invoice will retry automatically, or raise it manually in Zoho.`,
      ], "system");
    }
    return await fetchQuoteById(sb, quoteId);
  }
}

/**
 * Compose and send the "here is how to pay your deposit" email — the day-1
 * reminder copy, the customer's payment page (card or bank transfer) and the
 * FROZEN ask.
 *
 * Extracted so REQUESTING the deposit and RE-SENDING that request are the same
 * email, for the same reason sendBalanceInvoiceEmail was: a hand-typed message
 * from the comms composer would carry a different figure, a different link and
 * a different voice from the one the automation sends. Returns whether the send
 * succeeded; never throws, because a mail failure must not undo an acceptance.
 *
 * The deposit rail deliberately carries NO invoice PDF: the create path has
 * never attached one, and the whole reason this exists is that two copies of
 * one email drifted apart. The re-send is what the system already sends.
 */
async function sendDepositRequestEmail(
  sb: Sb,
  actorId: string | null,
  quote: AcceptQuoteRow,
  deposit: number,
  token: string,
  opts: { override?: boolean; overrideReason?: string } = {},
): Promise<boolean> {
  if (!quote.customer_email) return false;
  const owner = await ownerIdentity(sb, quote.estimator_id);
  // ONE brand resolve per send — copy, From, signature and template set all
  // derive from it (multi-brand PRD §3.5); marley/absent is byte-identical.
  const brand = await getBrandOrDefault(sb, quote.brand);
  const email = depositChaseEmail(1, {
    firstName: quote.customer_name,
    quoteRef: quote.quote_ref,
    acceptUrl: acceptUrlFor(token),
    expiryLabel: expiryLabelFrom(quote.email_sent_at, quote.created_at),
    ownerName: owner.name,
    ownerEmail: owner.email,
    // The FROZEN ask — a late booking's 25% collapse or an office-set deposit
    // must read the same here as on /q and the Zoho invoice (/qa 2026-08-05:
    // a £300 ask whose payment email said £100).
    depositAmount: depositLabel(deposit),
    brand,
  });
  const templateId = templateIdFor(brand, "RESEND_TEMPLATE_CHASE_DEPOSIT_1");
  const res = await dispatchComm(sb, actorId, {
    channel: "email",
    to: quote.customer_email,
    subject: email.subject,
    bodyText: email.text,
    ...(templateId
      ? { template: { id: templateId, variables: email.variables }, bodyHtml: chaseTextToHtml(email.text, brand) }
      : { bodyHtml: chaseTextToHtml(email.text, brand) }),
    replyTo: replyAddressFor(token, brand.name),
    from: email.from,
    leadId: quote.lead_id ?? undefined,
    quoteId: quote.id,
    clientId: quote.client_id ?? undefined,
    brand,
    ...(opts.override ? { override: true, overrideReason: opts.overrideReason } : {}),
  });
  return "ok" in res && res.ok;
}

/** The day-1 deposit email has gone out by hand, so the chase engine's next
 *  touch is day 3 rather than a second copy of the same message tomorrow. */
async function stampDepositChaseStarted(sb: Sb, leadId: string): Promise<void> {
  await sb
    .from("leads")
    .update({ deposit_chase_step: 1, deposit_chase_at: new Date().toISOString() } as never)
    .eq("id", leadId);
}

/**
 * Send an ALREADY-RAISED deposit request again, unchanged.
 *
 * The office needs this whenever a customer loses the email that told them how
 * to pay — the deposit rail's half of the gap Greig James found on the balance
 * rail (MMR015, 2026-08-20). It creates nothing: the £deposit Zoho invoice
 * already exists and is left exactly as it is, so the figure, the reference and
 * the payment page are the ones the customer was originally given.
 *
 * Refuses once the deposit is in. That is Peter's "stop the automated email if
 * it gets paid" rule, and it belongs on the server rather than on a hidden
 * button: a paid customer asked to pay again is worse than a silent one.
 * Sends with the duplicate guard overridden, because a deliberate re-send is
 * exactly the case that guard exists to catch and the operator has just said
 * they mean it.
 */
export async function resendDepositInvoiceFlow(
  sb: Sb,
  quoteId: string,
  actorId: string | null,
): Promise<{ ok: true; invoiceNumber: string; amount: number } | { ok: false; error: string }> {
  const quote = await fetchQuoteById(sb, quoteId);
  if (!quote) return { ok: false, error: "Quote not found" };

  const verdict = await canResendInvoiceNow(sb, quote, "deposit");
  if (!verdict.ok) return { ok: false, error: verdict.reason };

  // The payment page IS the deposit's payment surface, so no link means no
  // email worth sending. Lazily minted, exactly as the staff-accept path does.
  const token = quote.accept_token ?? (await ensureAcceptToken(sb, quote.id));
  if (!token) return { ok: false, error: "Could not build their payment link — try again in a moment." };

  const amount = Number(quote.deposit_amount ?? 0);
  const invoiceNumber = quote.zoho_deposit_invoice_number ?? "";

  const emailed = await sendDepositRequestEmail(sb, actorId, quote, amount, token, {
    override: true,
    overrideReason: "Operator re-sent the deposit request",
  });
  if (!emailed) return { ok: false, error: "The email did not send — check the comms log and try again." };

  if (quote.lead_id) {
    // Only when the ladder has not started: this IS the day-1 message, so
    // stamping it stops the cron sending an identical copy tomorrow. A lead
    // already on step 1 or 2 keeps its place — the cadence runs from
    // accepted_at, so nothing is delayed either way.
    const { data: lead } = await sb
      .from("leads")
      .select("deposit_chase_step")
      .eq("id", quote.lead_id)
      .maybeSingle();
    if ((lead?.deposit_chase_step ?? 0) === 0) await stampDepositChaseStarted(sb, quote.lead_id);

    await sb.from("activities").insert({
      lead_id: quote.lead_id,
      client_id: quote.client_id,
      actor_id: actorId,
      type: "note",
      summary: `Deposit request sent again to ${quote.customer_email} — £${amount.toFixed(2)} still due${invoiceNumber ? ` (invoice ${invoiceNumber})` : ""}`,
      meta: {
        quote_id: quoteId,
        invoice_id: quote.zoho_deposit_invoice_id,
        amount,
        rail: "deposit",
        resend: true,
      },
    } as never);
  }

  return { ok: true, invoiceNumber, amount };
}

/* ------------------------------------------------------------- deposit paid */

export interface DepositPaidOpts {
  method: "bank_transfer" | "card" | "cash";
  actorId: string | null; // null = system (cron / customer card payment)
  /** Record the payment against the Zoho deposit invoice too. Two card worlds:
   *  a Zoho-hosted-gateway card payment is ALREADY on the invoice → pass false;
   *  a takepayments card payment is NOT (different processor) → pass true, and
   *  it's recorded via `creditcard` mode. BACS/cash one-tap → true. */
  recordInZoho: boolean;
  /** Exact pence actually captured (card). Overrides quote.deposit_amount for
   *  the Zoho record, the customer email and the lead — money truth follows the
   *  charge, not a possibly-since-edited quote figure. */
  amountPence?: number;
  /** Last 4 of the card (card path only) — shown on the receipt. */
  cardLast4?: string | null;
}

const zohoMode = (method: string): "banktransfer" | "cash" | "creditcard" =>
  method === "cash" ? "cash" : method === "card" ? "creditcard" : "banktransfer";

/** Deposit landed: confirm the lead, close the chase, record in Zoho (BACS),
 *  email the customer, alert ops. Idempotent — a second call is a no-op. */
export async function markDepositPaid(
  sb: Sb,
  quoteId: string,
  opts: DepositPaidOpts,
): Promise<{ ok: boolean; already?: boolean; error?: string }> {
  const quote = await fetchQuoteById(sb, quoteId);
  if (!quote) return { ok: false, error: "Quote not found" };
  if (quote.deposit_paid_at) return { ok: true, already: true };

  const settings = await getBusinessSettings(sb);
  const deposit =
    opts.amountPence != null ? opts.amountPence / 100 : (quote.deposit_amount ?? settings.defaultDeposit);
  const now = new Date().toISOString();

  // Idempotency gate: only the first caller flips deposit_paid_at. A DB
  // error here is a FAILURE, not "already paid" — misreporting it as success
  // would skip Zoho, the customer email and the chase close while the UI
  // shows a green tick.
  const { data: won, error: gateErr } = await sb
    .from("quotes")
    .update({ deposit_paid_at: now, deposit_paid_method: opts.method } as never)
    .eq("id", quoteId)
    .is("deposit_paid_at", null)
    .select("id");
  if (gateErr) return { ok: false, error: gateErr.message };
  if (!won?.length) return { ok: true, already: true };

  // Zoho payment record (BACS path; card is already recorded by Zoho).
  if (
    opts.recordInZoho &&
    isRealZohoId(quote.zoho_deposit_invoice_id) &&
    isRealZohoId(quote.zoho_contact_id)
  ) {
    try {
      const status = await getInvoiceStatus(quote.zoho_deposit_invoice_id, asProvider(quote.deposit_invoice_provider));
      if (status.status !== "paid" && status.balance > 0) {
        await recordInvoicePayment(
          {
            customerId: quote.zoho_contact_id,
            invoiceId: quote.zoho_deposit_invoice_id,
            amount: Math.min(deposit, status.balance),
            mode: zohoMode(opts.method),
            reference: quote.quote_ref,
          },
          // Route to whichever ledger MINTED this invoice, exactly as the status
          // read above does. Without it, a payment against a pre-cutover Zoho
          // invoice is sent to Xero after the flip, fails, and the deposit ends
          // up marked paid in ops while appearing in neither set of books.
          asProvider(quote.deposit_invoice_provider),
        );
      }
    } catch (err) {
      await sendOpsAlert(`Zoho payment record FAILED — ${quote.quote_ref}`, [
        `The deposit for <strong>${quote.quote_ref}</strong> is marked paid in ops, but recording it against ${quote.zoho_deposit_invoice_number ?? "the Zoho invoice"} failed: ${err instanceof Error ? err.message : "unknown"}.`,
        `Record the payment manually in Zoho.`,
      ], "system");
    }
  }

  if (quote.lead_id) {
    const { data: lead } = await sb
      .from("leads")
      .select("status, client_id, first_contacted_at")
      .eq("id", quote.lead_id)
      .single();
    const patch: Record<string, unknown> = { deposit_paid_at: now, deposit_amount: deposit };
    if (lead && FUNNEL.indexOf(lead.status) < FUNNEL.indexOf("confirmed")) patch.status = "confirmed";
    if (lead && !lead.first_contacted_at) patch.first_contacted_at = now;
    const { error: leadPatchError } = await sb.from("leads").update(patch as never).eq("id", quote.lead_id);
    // The lead copy is what the lead page, the sales report and the bank-feed
    // matcher read. Silently losing this write strands the job Provisional with
    // a "Deposit received" button that no-ops forever (the quote gate above has
    // already flipped), so surface it rather than discard it.
    if (leadPatchError) {
      await sendOpsAlert(`Deposit recorded but the lead did not update — ${quote.quote_ref}`, [
        `The deposit for <strong>${quote.quote_ref}</strong> is recorded on the quote, but stamping the lead failed: ${leadPatchError.message}.`,
        `The job may still read Provisional/unpaid on the lead page — check it before chasing the customer.`,
      ], "money");
    }

    // A confirmed job belongs in the diary. Fail-soft by construction: the money
    // is already recorded, and every post-move safeguard keys off this row.
    await ensureRemovalAppointment(sb, quote);

    // The deposit card is answered by the money — outcome 'paid'.
    const { data: open } = await sb
      .from("follow_ups")
      .select("id")
      .eq("lead_id", quote.lead_id)
      .eq("reason", "deposit")
      .eq("status", "open");
    for (const fu of open ?? []) {
      await sb.from("follow_ups").update({ status: "done", outcome: "paid" }).eq("id", fu.id);
    }
    // Backstop for the pre-sale tasks: money down is the strongest possible
    // "this conversation is over" signal, and it catches leads that were
    // accepted offline or by a path that skipped the accept-time close.
    await closeOpenQuoteFollowUps(sb, quote.lead_id);

    await sb.from("activities").insert({
      lead_id: quote.lead_id,
      client_id: lead?.client_id ?? quote.client_id,
      actor_id: opts.actorId,
      type: "status_change",
      summary: `Deposit £${deposit.toFixed(0)} paid (${opts.method === "card" ? "card" : opts.method === "cash" ? "cash" : "bank transfer"}) — lead Confirmed`,
      meta: { quote_id: quoteId, method: opts.method },
    });
  }

  // Office push notification (best-effort — can never fail the payment; the
  // one-tapper themselves is excluded as the actor).
  await sendPushForEvent(
    paymentPush({ kind: "deposit", quoteId, customerName: quote.customer_name, leadId: quote.lead_id }),
    { actorUserId: opts.actorId },
  );

  // Captured so the ops alert below can report what actually happened rather
  // than assuming the customer was emailed.
  let receiptSend: Awaited<ReturnType<typeof dispatchComm>> | null = null;

  // Customer confirmation (duplicate-guarded). Prefers the published Resend
  // template (dashboard-editable copy); the in-repo HTML is the fallback.
  if (quote.customer_email) {
    const agreed = quote.agreed_price ?? Number(quote.grand_total ?? 0);
    const receipt: ReceiptDetails = {
      receiptNumber: depositReference(quote.quote_ref),
      paidAtLabel: ukReceiptDate(new Date(now)),
      method: opts.method,
      cardLast4: opts.cardLast4 ?? null,
      forLabel: "Booking deposit",
      amount: deposit,
    };
    const brand = await getBrandOrDefault(sb, quote.brand);
    const meta: DepositReceivedMeta = {
      firstName: quote.customer_name,
      quoteRef: quote.quote_ref,
      amount: deposit,
      moveDateLabel: moveDateLabel(quote.moving_date),
      balanceAmount: balanceDue(agreed, deposit),
      receipt,
      brand,
    };
    // New RECEIPT template var (falls back to the in-repo builder, which now
    // renders the receipt). The old RESEND_TEMPLATE_DEPOSIT_RECEIVED template
    // lacks the receipt panel, so it is deliberately no longer read here.
    const templateId = templateIdFor(brand, "RESEND_TEMPLATE_DEPOSIT_RECEIPT");
    receiptSend = await dispatchComm(sb, opts.actorId, {
      channel: "email",
      // Money desk identity — receipts come from accounts@, not the salesperson
      // (docs/email-identity-plan.md); replies still route via the token relay.
      from: accountsFromFor(brand),
      to: quote.customer_email,
      subject: `Deposit received. You're booked in (${quote.quote_ref})`,
      bodyText: `Deposit of £${deposit.toFixed(2)} received for quote ${quote.quote_ref} — receipt ${receipt.receiptNumber}, paid by ${paymentMethodLabel(opts.method, opts.cardLast4).toLowerCase()} on ${receipt.paidAtLabel}. Your move date is secured.`,
      ...(templateId
        ? { template: { id: templateId, variables: depositReceivedTemplateVars(meta) }, bodyHtml: buildDepositReceivedEmailHtml(meta) }
        : { bodyHtml: buildDepositReceivedEmailHtml(meta) }),
      // Replies route back into the panel (pause chase, log, follow-up).
      replyTo: quote.accept_token ? replyAddressFor(quote.accept_token, brand.name) : undefined,
      leadId: quote.lead_id ?? undefined,
      quoteId: quote.id,
      clientId: quote.client_id ?? undefined,
      brand,
    });
  }

  // Say what ACTUALLY happened. This line used to claim "the customer has the
  // confirmation email" unconditionally — including for a phone-only lead where
  // no send was even attempted (the email is gated on quote.customer_email
  // above), and for a send that failed. The accounts desk then moved on
  // believing a paying customer held written confirmation of their booking.
  const receiptLine = !quote.customer_email
    ? `NO EMAIL ON FILE — the customer has NO written confirmation. Confirm the booking by phone.`
    : receiptSend && "ok" in receiptSend && receiptSend.ok
      ? `Lead is now Confirmed and the receipt email is on its way to ${quote.customer_email}.`
      : receiptSend && "duplicate" in receiptSend && receiptSend.duplicate
        ? `Lead is now Confirmed; the receipt email had already been sent.`
        : `Lead is now Confirmed but the receipt email to ${quote.customer_email} did NOT send — re-send it from the lead page.`;
  await sendOpsAlert(`Deposit paid — ${quote.quote_ref}`, [
    `£${deposit.toFixed(2)} deposit received for <strong>${quote.quote_ref}</strong> (${quote.customer_name ?? "customer"}) via ${opts.method === "card" ? "card" : "bank transfer"}.`,
    receiptLine,
  ], "money");

  return { ok: true };
}

/* ------------------------------------------------------- commitment invoice */

/**
 * Raise the commitment invoice (Payments Policy v2: 25% of the gross agreed
 * price minus the deposit, ref <quoteRef>-COM) exactly once. Only fires after
 * the lead's move date is CONFIRMED (leads.date_confirmed_at) — before that
 * there is nothing to commit to. Zero-commitment suppression: when 25% x gross
 * <= deposit, no invoice is raised (confirmation still stands).
 *
 * Same never-create-twice machinery as the deposit: NULL → 'pending' claim,
 * reference-number orphan adoption, release-on-failure + ops alert. The amount
 * and due date are FROZEN onto the quote at raise time so later price edits
 * can't silently change what the customer was invoiced.
 *
 * BACS/cash only (disableOnlinePayments) — card stays deposit-only for now.
 */
export async function ensureCommitmentInvoice(sb: Sb, quoteId: string): Promise<AcceptQuoteRow | null> {
  const quote = await fetchQuoteById(sb, quoteId);
  if (!quote || quote.status !== "accepted" || !quote.lead_id) return quote;
  // Legacy iMVE jobs were sold under the old system's terms — no 25% commitment
  // was ever part of their deal, so the panel must never invoice one. All their
  // money moves are manual triggers (Attach dialog / mark-paid). The office's
  // standard-comms switch (after Luke's call) lifts this with the rest of the
  // email gates — see lib/legacy.ts for why that still can't invoice one
  // retroactively.
  if (legacyLocked(quote)) return quote;
  // A cancelled booking never raises money paperwork (belt-and-braces beside
  // the confirmMoveDate guard — this self-heals from /q too).
  if (quote.booking_cancelled_at) return quote;
  if (isRealZohoId(quote.zoho_commitment_invoice_id)) return quote;

  // Confirmation gate — the invoice exists BECAUSE the date was confirmed.
  // A declined (cancelled) lead never invoices either.
  const { data: lead } = await sb
    .from("leads")
    .select("status, date_confirmed_at")
    .eq("id", quote.lead_id)
    .maybeSingle();
  if (!lead?.date_confirmed_at || lead.status === "declined") return quote;

  // Once the FINAL BALANCE invoice exists, the whole remainder is already
  // billed — the balance only deducts a commitment raised BEFORE it — so a
  // commitment raised after it is always a double-bill. Priscilla Kong
  // (MMR020, 2026-08-14): fully settled, then the /q self-heal raised
  // INV-000243 for £573.80 on top of her paid balance invoice.
  if (isRealZohoId(quote.zoho_balance_invoice_id)) return quote;

  // The 25% is only invoiced when the CUSTOMER confirmed the date through the
  // app — the moment they were shown and agreed the commitment terms, which
  // always leaves a date_confirm signature. An office-verified stamp (phone
  // confirmations recorded so the T-7 automation applies) has no signature and
  // must never invent a payment ask nobody discussed: those bookings settle as
  // deposit + T-7 final balance. Read the signatures table, not the lead's
  // link column, so a failed link write can't change the answer.
  const { data: confirmSig } = await sb
    .from("signatures")
    .select("id")
    .eq("lead_id", quote.lead_id)
    .eq("kind", "date_confirm")
    .limit(1)
    .maybeSingle();
  if (!confirmSig) return quote;

  const settings = await getBusinessSettings(sb);
  const agreed = quote.agreed_price ?? Number(quote.grand_total ?? 0);
  const deposit = quote.deposit_amount ?? settings.defaultDeposit;
  const amount = commitmentAmount(agreed, deposit);
  if (amount <= 0) return quote; // deposit covers it — nothing to invoice

  const dueDate = commitmentDueDate(quote.moving_date);

  // Which ledger this raise talks to. Read ONCE per raise and written to the
  // row alongside every id it produces, so a later status poll routes to the
  // system that actually minted the document rather than to whatever the env
  // says today (0109).
  const ledger: LedgerProvider = configuredProvider();
  // Claim the creation slot: NULL → 'pending'. Only one caller wins.
  const { data: claimed } = await sb
    .from("quotes")
    .update({ zoho_commitment_invoice_id: "pending", commitment_invoice_provider: ledger } as never)
    .eq("id", quoteId)
    .is("zoho_commitment_invoice_id", null)
    .select("id");
  if (!claimed?.length) return quote; // another caller is on it (or just finished)

  const ref = commitmentReference(quote.quote_ref);
  try {
    // Crash-recovery: adopt an orphan created on a previous attempt.
    let inv = await findInvoiceByReference(ref);
    if (inv && !adoptedInvoiceMatches(inv.total, amount)) {
      // An invoice under this reference that bills a DIFFERENT figure was not
      // created by our crashed run — it is Connor's, raised by hand in Zoho.
      // Adopting it binds our record to his number while the customer holds his
      // PDF, so whichever they pay leaves one system wrong. Release and alert.
      await sb
        .from("quotes")
        .update({ zoho_commitment_invoice_id: null } as never)
        .eq("id", quoteId)
        .eq("zoho_commitment_invoice_id", "pending");
      await sendOpsAlert(`Commitment invoice NOT adopted — figure mismatch (${quote.quote_ref})`, [
        `An invoice already exists in Zoho under reference <strong>${ref}</strong> for £${(inv.total ?? 0).toFixed(2)}, but ops computed £${amount.toFixed(2)}.`,
        `It was NOT adopted. Reconcile ${inv.invoiceNumber} in Zoho (void it, or correct the figure), then retry.`,
      ], "money").catch(() => {});
      return quote;
    }
    let contactId = quote.zoho_contact_id;
    let contactProvider = quote.contact_provider;
    if (!inv) {
      // A contact id is reusable only inside the ledger that minted it (0109).
      if (!reusableContactId(contactId, contactProvider, ledger)) {
        contactId = await findOrCreateContact({
          name: quote.customer_name ?? "Customer",
          email: quote.customer_email,
          phone: quote.customer_phone,
          // Keyed on the client, not the name: Xero rejects (or worse, silently
          // adopts) a duplicate contact name. `partyForQuote` logs if it has to
          // fall back to the quote id.
          party: partyForQuote({ id: quote.id, clientId: quote.client_id }),
        });
        contactProvider = ledger;
      }
      // Invoice notes are customer-visible: the card mention follows the brand's
      // own card switch (§11.10) and the MarleyMoves Ltd disclosure follows
      // whether this is the default brand (§3.5) — two separate facts.
      const notesBrand = await getBrandOrDefault(sb, quote.brand);
      const payClause = invoicePayClause(notesBrand, quote.quote_ref, "Payable by");
      inv = await createInvoice({
        customerId: contactId!,
        reference: ref,
        description: `Booking commitment — removal quote ${quote.quote_ref} (25% of your move price, less your £${deposit.toFixed(2)} deposit)`,
        amount,
        notes: `Commitment payment for your confirmed move date, quote ${quote.quote_ref}. Due by ${dueDate}. It counts towards your final bill; the remaining balance is due in full before move day. ${payClause}`,
        disableOnlinePayments: true, // commitment is BACS/cash only — never card
      });
    }
    await sb
      .from("quotes")
      .update({
        zoho_contact_id: contactId,
        contact_provider: contactProvider,
        zoho_commitment_invoice_id: inv.invoiceId,
        commitment_invoice_provider: ledger,
        zoho_commitment_invoice_number: inv.invoiceNumber,
        zoho_commitment_invoice_url: inv.invoiceUrl,
        zoho_commitment_error: null,
        commitment_invoice_amount: amount,
        commitment_invoice_created_at: new Date().toISOString(),
        commitment_due_date: dueDate,
      } as never)
      .eq("id", quoteId);
    await resolveInvoiceRaiseFailed(sb);
    return await fetchQuoteById(sb, quoteId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Zoho commitment invoice failed";
    // Release the claim so the next page view / cron pass retries.
    await sb
      .from("quotes")
      .update({ zoho_commitment_invoice_id: null, zoho_commitment_error: msg } as never)
      .eq("id", quoteId)
      .eq("zoho_commitment_invoice_id", "pending");
    if (isLedgerAccessDenied(err)) await reportZohoAccessDenied(sb, { message: msg, while: "commitment invoice" });
    else {
      await reportInvoiceRaiseFailed(sb, { message: msg, kind: "commitment", quoteRef: quote.quote_ref, reference: ref });
      await sendOpsAlert(`Zoho commitment invoice FAILED — ${quote.quote_ref}`, [
        `Creating the £${amount.toFixed(2)} commitment invoice for <strong>${quote.quote_ref}</strong> failed: ${msg}`,
        `The date confirmation itself is recorded; the invoice will retry automatically, or raise it manually in Zoho (reference ${ref}).`,
      ], "system");
    }
    return await fetchQuoteById(sb, quoteId);
  }
}

/* ------------------------------------------------------- commitment paid */

export interface CommitmentPaidOpts {
  /** Commitment is BACS/cash only by policy (card stays deposit-only). */
  method: "bank_transfer" | "cash";
  actorId: string | null; // null = system (Zoho payment sync)
  /** Record the payment against the Zoho commitment invoice too (ops one-tap).
   *  Pass false when Zoho already knows (payment seen by the sync poll). */
  recordInZoho: boolean;
}

/** Commitment landed: stamp the quote, record in Zoho (BACS one-tap), close
 *  the commitment chase, email the customer, alert ops. Idempotent — the CAS
 *  on commitment_paid_at means a second call is a no-op; a DB error is a
 *  FAILURE, never "already paid". */
export async function markCommitmentPaid(
  sb: Sb,
  quoteId: string,
  opts: CommitmentPaidOpts,
): Promise<{ ok: boolean; already?: boolean; error?: string }> {
  const quote = await fetchQuoteById(sb, quoteId);
  if (!quote) return { ok: false, error: "Quote not found" };
  if (quote.commitment_paid_at) return { ok: true, already: true };

  const amount = Number(quote.commitment_invoice_amount ?? 0);
  const now = new Date().toISOString();

  // Single-winner CAS. Paying the commitment also clears the T-7 "date at
  // risk" discretion marker — a paid commitment is no longer at risk.
  const { data: won, error: gateErr } = await sb
    .from("quotes")
    .update({
      commitment_paid_at: now,
      commitment_paid_method: opts.method,
      date_releasable_at: null,
    } as never)
    .eq("id", quoteId)
    .is("commitment_paid_at", null)
    .select("id");
  if (gateErr) return { ok: false, error: gateErr.message };
  if (!won?.length) return { ok: true, already: true };

  // Zoho payment record (BACS/cash one-tap path), guarded by invoice status
  // so a repeat can never double-record.
  if (
    opts.recordInZoho &&
    isRealZohoId(quote.zoho_commitment_invoice_id) &&
    isRealZohoId(quote.zoho_contact_id)
  ) {
    try {
      const status = await getInvoiceStatus(quote.zoho_commitment_invoice_id, asProvider(quote.commitment_invoice_provider));
      if (status.status !== "paid" && status.balance > 0) {
        await recordInvoicePayment(
          {
            customerId: quote.zoho_contact_id,
            invoiceId: quote.zoho_commitment_invoice_id,
            amount: Math.min(amount || status.balance, status.balance),
            mode: zohoMode(opts.method),
            reference: quote.quote_ref,
          },
          asProvider(quote.commitment_invoice_provider),
        );
      }
    } catch (err) {
      await sendOpsAlert(`Zoho commitment payment record FAILED — ${quote.quote_ref}`, [
        `The commitment for <strong>${quote.quote_ref}</strong> is marked paid in ops, but recording it against ${quote.zoho_commitment_invoice_number ?? "the Zoho invoice"} failed: ${err instanceof Error ? err.message : "unknown"}.`,
        `Record the payment manually in Zoho.`,
      ], "system");
    }
  }

  if (quote.lead_id) {
    // Close the commitment chase (reason 'custom' + source 'commitment_chase'
    // — the chase cron's creation shape).
    const { data: open } = await sb
      .from("follow_ups")
      .select("id")
      .eq("lead_id", quote.lead_id)
      .eq("reason", "custom")
      .eq("source", "commitment_chase")
      .eq("status", "open");
    for (const fu of open ?? []) {
      await sb.from("follow_ups").update({ status: "done", outcome: "paid" }).eq("id", fu.id);
    }

    // Money-state change: timeline activity + audit log, both (fail-soft).
    await sb.from("activities").insert({
      lead_id: quote.lead_id,
      client_id: quote.client_id,
      actor_id: opts.actorId,
      type: "note",
      summary: `Commitment £${amount.toFixed(2)} paid (${opts.method === "cash" ? "cash" : "bank transfer"}) — balance due before move day`,
      meta: { quote_id: quoteId, method: opts.method, amount },
    });
  }
  const { error: eventErr } = await sb.from("events_log").insert({
    actor_id: opts.actorId,
    entity_type: "quote",
    entity_id: quoteId,
    action: "commitment_paid",
    diff: { amount, method: opts.method },
  } as never);
  if (eventErr) {
    await sendOpsAlert(`Commitment payment missing its audit log — ${quote.quote_ref}`, [
      `The commitment for ${quote.quote_ref} is marked paid but the events_log write failed: ${eventErr.message}`,
    ], "system");
  }

  // Customer confirmation (duplicate-guarded; template preferred, in-repo
  // fallback). Money mail comes from the accounts desk.
  if (quote.customer_email && amount > 0) {
    const receipt: ReceiptDetails = {
      receiptNumber: commitmentReference(quote.quote_ref),
      paidAtLabel: ukReceiptDate(new Date(now)),
      method: opts.method,
      forLabel: "Booking commitment",
      amount,
    };
    const brand = await getBrandOrDefault(sb, quote.brand);
    const meta: CommitmentReceivedMeta = {
      firstName: quote.customer_name,
      quoteRef: quote.quote_ref,
      amount,
      moveDateLabel: moveDateLabel(quote.moving_date),
      receipt,
      brand,
    };
    const templateId = templateIdFor(brand, "RESEND_TEMPLATE_COMMITMENT_RECEIPT");
    await dispatchComm(sb, opts.actorId, {
      channel: "email",
      from: accountsFromFor(brand),
      to: quote.customer_email,
      subject: `Payment received: commitment for your move (${quote.quote_ref})`,
      bodyText: `Commitment payment of £${amount.toFixed(2)} received for quote ${quote.quote_ref} — receipt ${receipt.receiptNumber}, paid by ${paymentMethodLabel(opts.method).toLowerCase()} on ${receipt.paidAtLabel}. It counts towards your final bill; the remaining balance is due before move day.`,
      ...(templateId
        ? { template: { id: templateId, variables: commitmentReceivedTemplateVars(meta) }, bodyHtml: buildCommitmentReceivedEmailHtml(meta) }
        : { bodyHtml: buildCommitmentReceivedEmailHtml(meta) }),
      replyTo: quote.accept_token ? replyAddressFor(quote.accept_token, brand.name) : undefined,
      leadId: quote.lead_id ?? undefined,
      quoteId: quote.id,
      clientId: quote.client_id ?? undefined,
      brand,
    });
  }

  await sendOpsAlert(`Commitment paid — ${quote.quote_ref}`, [
    `£${amount.toFixed(2)} commitment received for <strong>${quote.quote_ref}</strong> (${quote.customer_name ?? "customer"}) via ${opts.method === "cash" ? "cash" : "bank transfer"}.`,
    `The remaining balance is due before move day.`,
  ], "money");

  return { ok: true };
}

/* ------------------------------------------------------- date confirmation */

export interface DateConfirmInput {
  signerName: string;
  acks?: Record<string, unknown>;
  channel: "remote" | "in_person";
  /** 'drawn' only when a real pad image was captured in person; typed names
   *  stay the signature even when the script PNG render fails. */
  method: "typed" | "drawn";
  /** PNG data URI — the drawn signature, or the script rendering of the typed
   *  name (evidence nicety, not the signature itself when typed). */
  signatureImage?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  /** Office actor collecting in person; null on the public path. */
  collectedBy?: string | null;
}

export type DateConfirmOutcome =
  | { ok: true; already: boolean }
  | { ok: false; error: string };

/**
 * The date-confirmation pipeline (Payments Policy v2 §5A) — shared by the
 * public /q card and the office "Confirm in person" dialog:
 *
 *   validate (accepted + deposit paid + move date set + ack ticked)
 *   → CAS-stamp leads.date_confirmed_at (single winner; deposit becomes
 *     non-refundable AT this instant — refundability is derived, no boolean)
 *   → signatures row kind 'date_confirm' (23505-tolerant; non-duplicate
 *     failure rolls the CAS back so state and evidence never split)
 *   → leads.date_confirm_signature_id
 *   → ensureCommitmentInvoice (zero-amount suppression inside)
 *   → date-confirmation email (invoice PDF best-effort)
 *   → activities + events_log + ops alert.
 *
 * Everything after the signature is fail-soft: the confirmation stands even
 * if a secondary side effect fails (each failure alerts ops).
 */
export async function confirmMoveDate(
  sb: Sb,
  quoteId: string,
  input: DateConfirmInput,
): Promise<DateConfirmOutcome> {
  const quote = await fetchQuoteById(sb, quoteId);
  if (!quote || !quote.lead_id) return { ok: false, error: "This quote is no longer available." };
  // Imported iMVE bookings arrive date-confirmed, so this normally answers
  // `already: true` upstream. If one ever reaches here un-confirmed, refuse:
  // the confirmation email quotes the 25% commitment terms these customers
  // never agreed to, and the flow would try to invoice them for it. Once the
  // office has informed the customer by phone (standard_comms_at set), the
  // flow opens up like any other booking.
  if (legacyLocked(quote)) {
    return {
      ok: false,
      error: "This is a legacy iMVE booking — its date is managed manually, the online confirmation (and its commitment terms) doesn't apply.",
    };
  }
  if (quote.status !== "accepted") {
    return { ok: false, error: "The quote must be accepted before the move date is confirmed." };
  }
  if (quote.booking_cancelled_at) {
    return { ok: false, error: "This booking has been cancelled — call 01747 637070 if you'd like to rebook." };
  }
  if (!quote.deposit_paid_at) {
    return { ok: false, error: "The deposit must be paid before the move date is confirmed." };
  }
  if (!quote.moving_date) {
    return { ok: false, error: "There's no move date on this booking yet — nothing to confirm." };
  }
  const name = input.signerName.trim().slice(0, 120);
  if (name.length < 2) return { ok: false, error: "Type your full name to confirm the date." };
  if (!allDateConfirmAcksConfirmed(input.acks)) {
    return { ok: false, error: "Please tick the confirmation box to confirm your move date." };
  }
  if (input.method === "drawn" && !isValidSignatureDataUri(input.signatureImage)) {
    return { ok: false, error: "The signature didn't come through — please sign again." };
  }

  const { data: lead } = await sb
    .from("leads")
    .select("id, client_id, status, date_confirmed_at")
    .eq("id", quote.lead_id)
    .maybeSingle();
  if (!lead) return { ok: false, error: "This quote is no longer available." };
  // A dead lead's emailed /q link must not flip the deposit non-refundable or
  // raise a fresh commitment invoice for a cancelled job — the pending refund
  // row and a signed non-refundability record would contradict each other.
  if (lead.status === "declined") {
    return { ok: false, error: "This booking has been cancelled — call 01747 637070 if you'd like to rebook." };
  }
  if (lead.date_confirmed_at) return { ok: true, already: true };

  // Single-winner CAS — the instant the deposit becomes non-refundable.
  const confirmedAt = new Date().toISOString();
  const { data: won, error: gateErr } = await sb
    .from("leads")
    .update({ date_confirmed_at: confirmedAt } as never)
    .eq("id", quote.lead_id)
    .is("date_confirmed_at", null)
    .select("id");
  if (gateErr) return { ok: false, error: "Something went wrong — please call 01747 637070." };
  if (!won?.length) {
    // Someone else won the race (two tabs, a replay) — that confirmation stands.
    const { data: again } = await sb
      .from("leads")
      .select("date_confirmed_at")
      .eq("id", quote.lead_id)
      .maybeSingle();
    if (again?.date_confirmed_at) return { ok: true, already: true };
    return { ok: false, error: "Something went wrong — please call 01747 637070." };
  }

  // Evidence row. One per quote (partial unique index) — a 23505 means a
  // parallel submit already recorded it; adopt that row.
  let signatureId: string | null = null;
  const { data: sigRow, error: sigErr } = await sb
    .from("signatures")
    .insert({
      kind: "date_confirm",
      quote_id: quote.id,
      lead_id: quote.lead_id,
      client_id: quote.client_id,
      signer_name: name,
      signature_data: isValidSignatureDataUri(input.signatureImage) ? input.signatureImage : null,
      method: input.method,
      channel: input.channel,
      acknowledgments: normalizeDateConfirmAcks(input.acks),
      ...termsSnapshot("customer-terms"),
      ip: input.ip ?? null,
      user_agent: input.userAgent ?? null,
      collected_by: input.collectedBy ?? null,
    } as never)
    .select("id")
    .single();
  if (sigErr && sigErr.code === "23505") {
    const { data: existing } = await sb
      .from("signatures")
      .select("id")
      .eq("quote_id", quote.id)
      .eq("kind", "date_confirm")
      .limit(1)
      .maybeSingle();
    signatureId = existing?.id ?? null;
  } else if (sigErr || !sigRow) {
    // Keep the non-refundability flip and its evidence together: roll the CAS
    // back, bound to OUR stamp so a later confirmation can't be undone.
    const { data: rolledBack } = await sb
      .from("leads")
      .update({ date_confirmed_at: null } as never)
      .eq("id", quote.lead_id)
      .eq("date_confirmed_at", confirmedAt)
      .select("id");
    if (!rolledBack?.length) {
      await sendOpsAlert(`Date-confirmation evidence FAILED — ${quote.quote_ref}`, [
        `The move date on <strong>${quote.quote_ref}</strong> was confirmed but its signature record failed and the safe rollback did not win.`,
        `Do not treat the deposit as non-refundable until the confirmation evidence is repaired.`,
      ], "system").catch(() => {});
    }
    return { ok: false, error: "We couldn't save the confirmation — please try again or call 01747 637070." };
  } else {
    signatureId = sigRow.id;
  }

  if (signatureId) {
    const { error: linkErr } = await sb
      .from("leads")
      .update({ date_confirm_signature_id: signatureId } as never)
      .eq("id", quote.lead_id);
    if (linkErr) {
      await sendOpsAlert(`Date-confirmation signature link failed — ${quote.quote_ref}`, [
        `leads.date_confirm_signature_id could not be written (${linkErr.message}); the signature row ${signatureId} exists and the confirmation stands.`,
      ], "system");
    }
  }

  // Safety net for the diary: a date-certain job must have its slot even if the
  // deposit was recorded before this hook existed, or landed by a path that
  // skipped markDepositPaid (a carried deposit on a re-quote).
  await ensureRemovalAppointment(sb, quote);

  // The T-10 "call them, the date isn't confirmed" task is answered by this
  // confirmation. Nothing closed it — markCommitmentPaid only closes the
  // commitment-chase variant, and when 25% ≤ the deposit no commitment invoice
  // is raised at all, so that never runs and the card was permanent: still
  // telling the office to ring about a date the customer confirmed themselves,
  // through the move and forever after.
  const { error: nudgeCloseError } = await sb
    .from("follow_ups")
    .update({ status: "done", outcome: "reached" })
    .eq("lead_id", quote.lead_id)
    .eq("reason", "custom")
    .eq("source", "commitment_chase")
    .eq("metadata->>kind", "confirm_date")
    .eq("status", "open");
  if (nudgeCloseError) {
    log.warn("date_confirm.nudge_close_failed", { quoteId: quote.id, error: nudgeCloseError.message });
  }

  // Raise the commitment invoice (fail-soft — it self-heals via /q + cron).
  const refreshed = (await ensureCommitmentInvoice(sb, quote.id)) ?? quote;
  const settings = await getBusinessSettings(sb);
  const agreed = quote.agreed_price ?? Number(quote.grand_total ?? 0);
  const deposit = quote.deposit_amount ?? settings.defaultDeposit;
  const commitAmt = refreshed.commitment_invoice_amount ?? commitmentAmount(agreed, deposit);
  const dueDate = refreshed.commitment_due_date ?? commitmentDueDate(quote.moving_date);
  const dueLabel = moveDateLabel(dueDate);

  // Date-confirmation email — states the held/non-refundable position and the
  // commitment (invoice PDF attached best-effort). Duplicate-guarded.
  await sendDateConfirmationEmail(sb, input.collectedBy ?? null, quote, {
    depositAmount: deposit,
    commitmentAmount: commitAmt,
    commitmentDueLabel: dueLabel,
    invoiceId: refreshed.zoho_commitment_invoice_id,
    invoiceNumber: refreshed.zoho_commitment_invoice_number,
    invoiceUrl: refreshed.zoho_commitment_invoice_url,
  });

  // Money-state change: timeline + audit, both (fail-soft each).
  await sb.from("activities").insert({
    lead_id: quote.lead_id,
    client_id: lead.client_id ?? quote.client_id,
    actor_id: input.collectedBy ?? null,
    type: "status_change",
    summary: `Move date confirmed by "${name}" (${channelLabel(input.channel)}) — deposit now non-refundable${commitAmt > 0 ? `; £${commitAmt.toFixed(2)} commitment due ${dueLabel ?? "now"}` : ""}`,
    meta: {
      quote_id: quote.id,
      signature_id: signatureId,
      via: input.channel === "in_person" ? "office_collect" : "accept_page",
      commitment_amount: commitAmt,
      commitment_due_date: dueDate,
    },
  });
  const { error: eventErr } = await sb.from("events_log").insert({
    actor_id: input.collectedBy ?? null,
    entity_type: "lead",
    entity_id: quote.lead_id,
    action: "date_confirmed",
    diff: {
      quote_id: quote.id,
      channel: input.channel,
      method: input.method,
      commitment_amount: commitAmt,
      commitment_due_date: dueDate,
    },
  } as never);
  if (eventErr) {
    await sendOpsAlert(`Date confirmation missing its audit log — ${quote.quote_ref}`, [
      `The move date on ${quote.quote_ref} is confirmed but the events_log write failed: ${eventErr.message}`,
    ], "system");
  }

  await sendOpsAlert(`Move date confirmed — ${quote.quote_ref}`, [
    `<strong>${escapeHtml(quote.customer_name ?? "Customer")}</strong> confirmed their move${moveDateLabel(quote.moving_date) ? ` on <strong>${moveDateLabel(quote.moving_date)}</strong>` : ""} (signed "${escapeHtml(name)}", ${channelLabel(input.channel)}).`,
    `The £${deposit.toFixed(2)} deposit is now non-refundable and counts towards the final bill.`,
    commitAmt > 0
      ? `Commitment invoice: £${commitAmt.toFixed(2)} ${dueLabel ? `due by ${dueLabel}` : "due now"}${refreshed.zoho_commitment_invoice_number ? ` (${refreshed.zoho_commitment_invoice_number})` : " — invoice creation will retry if it failed"}.`
      : `No commitment invoice needed — the deposit already covers 25% of the job price.`,
  ], "money");

  return { ok: true, already: false };
}

/** Public wrapper — the customer confirms from the /q card. The unguessable
 *  token is the credential, exactly like acceptQuoteOnline. */
export async function confirmMoveDateOnline(
  sb: Sb,
  token: string,
  fullName: string,
  ip: string | null,
  opts?: { acks?: Record<string, unknown>; userAgent?: string | null; signatureImage?: string | null },
): Promise<DateConfirmOutcome> {
  const quote = await fetchQuoteByToken(sb, token);
  if (!quote) return { ok: false, error: "This link is no longer valid." };
  return confirmMoveDate(sb, quote.id, {
    signerName: fullName,
    acks: opts?.acks,
    channel: "remote",
    method: "typed",
    signatureImage: opts?.signatureImage ?? null,
    ip,
    userAgent: opts?.userAgent ?? null,
  });
}

/** The raised commitment invoice, as both the confirmation and the re-send
 *  path know it. A zero-commitment booking (the deposit already covers 25%)
 *  carries no invoice at all, which is why every field is nullable. */
interface ConfirmedCommitment {
  /** The gross deposit already paid. */
  depositAmount: number;
  /** The 25% invoice figure. 0 = the deposit covers it, no invoice raised. */
  commitmentAmount: number;
  /** Pre-formatted due-date label, null = due now. */
  commitmentDueLabel: string | null;
  invoiceId: string | null;
  invoiceNumber: string | null;
  invoiceUrl: string | null;
}

/**
 * Compose and send the "your date is locked in" email — the held/non-refundable
 * position, the 25% commitment invoice with its due date and bank details, and
 * Zoho's own VAT invoice PDF.
 *
 * Extracted so CONFIRMING the date and RE-SENDING its invoice are the same
 * email, exactly as sendBalanceInvoiceEmail is for the balance rail. This IS
 * the email that carries the commitment invoice to the customer, so a re-send
 * that composed anything else would hand them a second, different-looking
 * document for money they have already been invoiced for. Returns whether the
 * send succeeded; never throws, because a mail failure must not undo a
 * confirmation (or an invoice that exists in Zoho).
 */
async function sendDateConfirmationEmail(
  sb: Sb,
  actorId: string | null,
  quote: AcceptQuoteRow,
  c: ConfirmedCommitment,
  opts: { override?: boolean; overrideReason?: string } = {},
): Promise<boolean> {
  if (!quote.customer_email) return false;
  let pdfBase64: string | undefined;
  if (c.commitmentAmount > 0 && isRealZohoId(c.invoiceId)) {
    try {
      // Stamped, for the same reason as the payment writes: a re-send of a
      // pre-cutover invoice must read it from the ledger that minted it. A null
      // stamp means "no override" and falls through to the configured provider,
      // which is right for an invoice raised moments ago.
      pdfBase64 = await getInvoicePdfBase64(c.invoiceId, asProvider(quote.commitment_invoice_provider));
    } catch (err) {
      // Send without the attachment rather than not at all — but SAY so. This
      // email asks a customer for money; losing the VAT invoice off it silently
      // is how "where do I pay?" becomes a support ticket instead of a defect.
      pdfBase64 = undefined;
      log.warn("ledger.invoice_pdf_unavailable", {
        quoteId: quote.id,
        slot: "commitment",
        invoiceId: c.invoiceId,
        ...errorContext(err),
      });
    }
  }
  const brand = await getBrandOrDefault(sb, quote.brand);
  // Settle-in-full (PRD §3.10 Addition 3) is advertised only where the /q page
  // would actually honour it, so this reads the SAME gate rather than inferring
  // an offer from the commitment amount: an email offering a choice the page
  // refuses is worse than no offer at all. Read FRESH — the commitment invoice
  // was raised moments ago and `quote` predates it, so the passed-in row would
  // fail the gate for the wrong reason.
  let balanceRemaining = 0;
  const fresh = await fetchQuoteById(sb, quote.id);
  if (fresh?.lead_id) {
    const { data: payLead } = await sb
      .from("leads")
      .select("date_confirmed_at, balance_paid_at")
      .eq("id", fresh.lead_id)
      .maybeSingle();
    if (payInFullAvailable(fresh, payLead)) {
      balanceRemaining = (await computeBalanceCredits(sb, fresh)).amount;
    }
  }
  const meta: DateConfirmationMeta = {
    firstName: quote.customer_name,
    quoteRef: quote.quote_ref,
    moveDateLabel: moveDateLabel(quote.moving_date),
    depositAmount: c.depositAmount,
    commitmentAmount: c.commitmentAmount,
    commitmentDueLabel: c.commitmentDueLabel,
    invoiceNumber: c.invoiceNumber,
    invoiceUrl: c.invoiceUrl,
    balanceRemaining,
    payUrl: quote.accept_token ? acceptUrlFor(quote.accept_token) : null,
    brand,
  };
  const templateId = templateIdFor(brand, "RESEND_TEMPLATE_DATE_CONFIRMATION");
  const res = await dispatchComm(sb, actorId, {
    channel: "email",
    from: accountsFromFor(brand),
    to: quote.customer_email,
    subject: `Move date confirmed (${quote.quote_ref})`,
    bodyText:
      c.commitmentAmount > 0
        ? `Your move date is confirmed (quote ${quote.quote_ref}). Your deposit is now non-refundable and counts towards your final bill. Your £${c.commitmentAmount.toFixed(2)} commitment payment is ${c.commitmentDueLabel ? `due by ${c.commitmentDueLabel}` : "due now"}.`
        : `Your move date is confirmed (quote ${quote.quote_ref}). Your deposit is now non-refundable and counts towards your final bill. Nothing more to pay right now; the balance is due before move day.`,
    ...(templateId
      ? { template: { id: templateId, variables: dateConfirmationTemplateVars(meta) }, bodyHtml: buildDateConfirmationEmailHtml(meta) }
      : { bodyHtml: buildDateConfirmationEmailHtml(meta) }),
    attachmentBase64: pdfBase64,
    attachmentName: pdfBase64
      ? `MarleyMoves-Invoice-${c.invoiceNumber ?? "commitment"}.pdf`
      : undefined,
    replyTo: quote.accept_token ? replyAddressFor(quote.accept_token, brand.name) : undefined,
    leadId: quote.lead_id ?? undefined,
    quoteId: quote.id,
    clientId: quote.client_id ?? undefined,
    brand,
    ...(opts.override ? { override: true, overrideReason: opts.overrideReason } : {}),
  });
  return "ok" in res && res.ok;
}

/**
 * Send an ALREADY-RAISED commitment (25%) invoice again, unchanged.
 *
 * The commitment rail's half of the gap Greig James found on the balance rail
 * (MMR015, 2026-08-20): the invoice is raised once, at date confirmation, and
 * a customer who loses that email had no way to be sent it again. This re-sends
 * the SAME invoice number, figure and PDF, and takes nothing from the caller
 * that could change them — the frozen commitment_invoice_amount is the figure,
 * and nothing here can raise an invoice (ensureCommitmentInvoice is not called;
 * a job with no commitment is refused, not invoiced).
 *
 * Refuses once the commitment is in, and refuses a legacy iMVE booking whose
 * standard comms are switched off: that lock is the whole reason those
 * customers are not emailed Marley's standard correspondence, and it can be
 * lifted from the lead page when the office has spoken to them.
 */
export async function resendCommitmentInvoiceFlow(
  sb: Sb,
  quoteId: string,
  actorId: string | null,
): Promise<{ ok: true; invoiceNumber: string; amount: number } | { ok: false; error: string }> {
  const quote = await fetchQuoteById(sb, quoteId);
  if (!quote) return { ok: false, error: "Quote not found" };

  const verdict = await canResendInvoiceNow(sb, quote, "commitment");
  if (!verdict.ok) return { ok: false, error: verdict.reason };

  const settings = await getBusinessSettings(sb);
  const amount = Number(quote.commitment_invoice_amount ?? 0);
  const invoiceNumber = quote.zoho_commitment_invoice_number ?? "";

  const emailed = await sendDateConfirmationEmail(
    sb,
    actorId,
    quote,
    {
      depositAmount: quote.deposit_amount ?? settings.defaultDeposit,
      commitmentAmount: amount,
      // The FROZEN due date, not a recomputed one: the customer is looking at
      // the date printed on the invoice they already hold.
      commitmentDueLabel: moveDateLabel(quote.commitment_due_date),
      invoiceId: quote.zoho_commitment_invoice_id,
      invoiceNumber,
      invoiceUrl: quote.zoho_commitment_invoice_url,
    },
    { override: true, overrideReason: "Operator re-sent the commitment invoice" },
  );
  if (!emailed) return { ok: false, error: "The email did not send — check the comms log and try again." };

  if (quote.lead_id) {
    await sb.from("activities").insert({
      lead_id: quote.lead_id,
      client_id: quote.client_id,
      actor_id: actorId,
      type: "note",
      summary: `Commitment invoice ${invoiceNumber} sent again to ${quote.customer_email} — £${amount.toFixed(2)} still due`,
      meta: {
        quote_id: quoteId,
        invoice_id: quote.zoho_commitment_invoice_id,
        amount,
        rail: "commitment",
        resend: true,
      },
    } as never);
  }

  return { ok: true, invoiceNumber, amount };
}

/* ------------------------------------------------------------- balance invoice */

export type BalanceInvoiceOutcome =
  | { ok: true; invoiceNumber: string; amount: number; emailed: boolean }
  | { ok: false; error: string };

export interface BalanceCredits {
  agreed: number;
  depositCredit: number;
  commitmentCredit: number;
  forfeited: number;
  amount: number;
}

/**
 * The ONE balance-invoice computation — used by both the confirm dialog
 * (getBalanceInvoiceInfo) and createBalanceInvoiceFlow so the figure the
 * office approves is always the figure that lands in Zoho.
 *
 * The invoices PARTITION the agreed price (header doctrine: they must sum
 * exactly to agreed_price). A -DEP invoice always exists for an accepted
 * quote and still demands its amount while unpaid, so the deposit is ALWAYS
 * carved out; the commitment is carved out once its -COM invoice has been
 * RAISED (paid or not — an outstanding -COM still demands it). Gating these
 * on payment would double-invoice: an outstanding -DEP/-COM plus a balance
 * that includes the same money.
 *
 * Rebook forfeit (PRD §1): money RETAINED on a date-change queue row (the
 * old day died unfilled) has STOPPED counting toward this booking — without
 * this exclusion the balance would silently credit money the customer
 * forfeited, netting Marley £0 from the retention. Chronological first-in:
 * the forfeit consumes the deposit credit first, then the commitment credit.
 */
export async function computeBalanceCredits(sb: Sb, quote: AcceptQuoteRow): Promise<BalanceCredits> {
  const settings = await getBusinessSettings(sb);
  const agreed = quote.agreed_price ?? Number(quote.grand_total ?? 0);
  // Policy-aware: a COMMERCIAL job has no deposit rung, so nothing is carved
  // out and its completion invoice is the whole agreed price. This is the half
  // of the deposit bug that reaches the CUSTOMER rather than a screen — the
  // partition doctrine above assumes a -DEP invoice exists demanding the
  // carve-out, and on a commercial booking none ever does, so every penny
  // deducted here is simply never billed to anyone.
  const deposit = depositOfQuote(quote, settings.defaultDeposit);
  let depositCredit = deposit;
  let commitmentCredit = isRealZohoId(quote.zoho_commitment_invoice_id)
    ? Number(quote.commitment_invoice_amount ?? 0)
    : 0;

  let forfeited = 0;
  if (quote.lead_id) {
    // Service role: refund_queue reads are admin-RLS'd, but this exclusion
    // must hold no matter which office session raises the invoice.
    const { data: forfeitRows } = await createAdminClient()
      .from("refund_queue")
      .select("held, conditional_amount")
      .eq("lead_id", quote.lead_id)
      .eq("trigger", "customer_date_change")
      .eq("status", "retained");
    let forfeitedPence = 0;
    for (const row of forfeitRows ?? []) {
      forfeitedPence += retainedPenceFor(
        parseHeld(row.held),
        Math.round(Number(row.conditional_amount) * 100),
      );
    }
    forfeited = round2(forfeitedPence / 100);
    let left = forfeited;
    const fromDeposit = Math.min(depositCredit, left);
    depositCredit = round2(depositCredit - fromDeposit);
    left = round2(left - fromDeposit);
    const fromCommitment = Math.min(commitmentCredit, left);
    commitmentCredit = round2(commitmentCredit - fromCommitment);
  }

  const amount = round2(Math.max(0, agreed - depositCredit - commitmentCredit));
  return { agreed, depositCredit, commitmentCredit, forfeited, amount };
}

/** The raised balance invoice, as both the create and re-send paths know it. */
interface RaisedBalanceInvoice {
  invoiceId: string;
  invoiceNumber: string;
  invoiceUrl?: string | null;
  amount: number;
}

/**
 * Compose and send the "your final balance" email — branded body (or its Resend
 * template twin) plus Zoho's own VAT invoice PDF.
 *
 * Extracted so RAISING the invoice and RE-SENDING it are the same email. They
 * were one inlined block, which meant a re-send could only ever be a hand-typed
 * message from the comms composer: no PDF, no invoice link, no bank panel — the
 * customer would get something visibly unlike the original and still have to
 * ask where to pay. Returns whether the send succeeded; never throws, because a
 * mail failure must not undo an invoice that exists in Zoho.
 */
async function sendBalanceInvoiceEmail(
  sb: Sb,
  actorId: string | null,
  quote: AcceptQuoteRow,
  inv: RaisedBalanceInvoice,
  opts: { override?: boolean; overrideReason?: string } = {},
): Promise<boolean> {
  if (!quote.customer_email) return false;
  let pdfBase64: string | undefined;
  try {
    pdfBase64 = await getInvoicePdfBase64(inv.invoiceId, asProvider(quote.balance_invoice_provider));
  } catch (err) {
    pdfBase64 = undefined; // send without the attachment rather than not at all
    log.warn("ledger.invoice_pdf_unavailable", {
      quoteId: quote.id,
      slot: "balance",
      invoiceId: inv.invoiceId,
      ...errorContext(err),
    });
  }
  const brand = await getBrandOrDefault(sb, quote.brand);
  // What the deposit rail still owes. The default copy tells the customer their
  // deposit "is already accounted for" — true of the arithmetic (the balance is
  // agreed − deposit whether or not it has been paid) and read by someone who
  // has paid nothing as "you have already paid it". That combination used to be
  // near-impossible; gate 9b makes it ordinary, because a late booking now meets
  // this email BEFORE paying anything. Derived from the quote rather than passed
  // in, so the raise, the early raise and the office re-send all tell one truth.
  const depositOutstanding = quote.deposit_paid_at ? 0 : round2(Number(quote.deposit_amount ?? 0));
  const meta: BalanceInvoiceMeta = {
    firstName: quote.customer_name,
    quoteRef: quote.quote_ref,
    amount: inv.amount,
    moveDateLabel: moveDateLabel(quote.moving_date),
    invoiceUrl: inv.invoiceUrl,
    invoiceNumber: inv.invoiceNumber,
    depositOutstanding,
    brand,
  };
  // The hosted Resend twin is a separately hand-written copy of this email
  // (scripts/create-resend-templates.mjs) with no slot for the outstanding
  // deposit, so sending through it would show the "already accounted for" line
  // to exactly the customer it is wrong for. Fall back to the locally built
  // HTML — the same shell, and the one that carries the correct figures.
  const templateId =
    depositOutstanding > 0 ? null : templateIdFor(brand, "RESEND_TEMPLATE_BALANCE_INVOICE");
  const res = await dispatchComm(sb, actorId, {
    channel: "email",
    from: accountsFromFor(brand),
    to: quote.customer_email,
    subject: `Your final balance: ${quote.quote_ref} (£${inv.amount.toFixed(2)})`,
    bodyText:
      `Final balance of £${inv.amount.toFixed(2)} for quote ${quote.quote_ref} (invoice ${inv.invoiceNumber}). ` +
      (depositOutstanding > 0
        ? `Your £${depositOutstanding.toFixed(2)} deposit is invoiced separately and still to pay, so £${(depositOutstanding + inv.amount).toFixed(2)} is due before move day.`
        : `Payment in full is due before move day.`),
    ...(templateId
      ? { template: { id: templateId, variables: balanceInvoiceTemplateVars(meta) }, bodyHtml: buildBalanceInvoiceEmailHtml(meta) }
      : { bodyHtml: buildBalanceInvoiceEmailHtml(meta) }),
    attachmentBase64: pdfBase64,
    attachmentName: pdfBase64 ? `MarleyMoves-Invoice-${inv.invoiceNumber}.pdf` : undefined,
    replyTo: quote.accept_token ? replyAddressFor(quote.accept_token, brand.name) : undefined,
    leadId: quote.lead_id ?? undefined,
    quoteId: quote.id,
    clientId: quote.client_id ?? undefined,
    brand,
    ...(opts.override ? { override: true, overrideReason: opts.overrideReason } : {}),
  });
  return "ok" in res && res.ok;
}

/**
 * Send an ALREADY-RAISED final invoice again, unchanged.
 *
 * The office needs this whenever a customer asks to settle up before we would
 * otherwise have chased them (Greig James MMR015, 2026-08-20: invoice raised
 * 14 Aug, customer replied five days later asking for a link to pay). Creating
 * a second invoice is forbidden — one job, one VAT document — so this re-sends
 * the SAME invoice number, figure and PDF, and takes nothing from the caller
 * that could change them.
 *
 * Refuses once the balance is settled. That is Peter's "stop the automated
 * email if it gets paid" rule, and it belongs on the server rather than on a
 * hidden button: a paid customer asked to pay again is worse than a silent one.
 * Sends with the duplicate guard overridden, because a deliberate re-send is
 * exactly the case that guard exists to catch and the operator has just said
 * they mean it.
 */
export async function resendBalanceInvoiceFlow(
  sb: Sb,
  quoteId: string,
  actorId: string | null,
): Promise<{ ok: true; invoiceNumber: string; amount: number } | { ok: false; error: string }> {
  const quote = await fetchQuoteById(sb, quoteId);
  if (!quote) return { ok: false, error: "Quote not found" };

  let balancePaid = false;
  let paidStateUnknown = false;
  if (quote.lead_id) {
    const { data: lead, error } = await sb
      .from("leads")
      .select("balance_paid_at")
      .eq("id", quote.lead_id)
      .maybeSingle();
    if (error) paidStateUnknown = true;
    else balancePaid = !!lead?.balance_paid_at;
  }

  const amount = Number(quote.balance_invoice_amount ?? 0);
  const verdict = canResendBalanceInvoice({
    invoiceRaised: isRealZohoId(quote.zoho_balance_invoice_id),
    invoicedAmount: amount,
    bookingCancelled: !!quote.booking_cancelled_at,
    hasCustomerEmail: !!quote.customer_email,
    balancePaid,
    paidStateUnknown,
    // Deliberately NOT legacyLocked(quote), unlike the deposit and commitment
    // rails. Since the 2026-08-13 iMVE import the panel owns balance invoicing
    // for those bookings, and createBalanceInvoiceFlow has no legacy gate
    // either — so the office raises and emails a final invoice to a legacy
    // customer on purpose. Locking the RE-send while allowing the original send
    // would refuse exactly the customers we are trying to collect from, and
    // would do it in the one state where they have asked where to pay. The lock
    // governs Marley's AUTOMATED correspondence, not operator-initiated
    // collection: the T-7 auto final-invoice IS gated on it.
    commsLocked: false,
  });
  if (!verdict.ok) return { ok: false, error: verdict.reason };

  const invoiceNumber = quote.zoho_balance_invoice_number ?? "";

  const emailed = await sendBalanceInvoiceEmail(
    sb,
    actorId,
    quote,
    {
      invoiceId: quote.zoho_balance_invoice_id!,
      invoiceNumber,
      invoiceUrl: quote.zoho_balance_invoice_url,
      amount,
    },
    { override: true, overrideReason: "Operator re-sent the final invoice" },
  );
  if (!emailed) return { ok: false, error: "The email did not send — check the comms log and try again." };

  if (quote.lead_id) {
    await sb.from("activities").insert({
      lead_id: quote.lead_id,
      client_id: quote.client_id,
      actor_id: actorId,
      type: "note",
      summary: `Final invoice ${invoiceNumber} sent again to ${quote.customer_email} — £${amount.toFixed(2)} still due`,
      meta: { quote_id: quoteId, invoice_id: quote.zoho_balance_invoice_id, amount, resend: true },
    } as never);
  }

  return { ok: true, invoiceNumber, amount };
}

/**
 * Raise the pre-move balance invoice exactly once and email it (branded email +
 * Zoho's own VAT invoice PDF attached). Triggered by the manual button in the
 * schedule / lead payments card; date-based automation can call this later.
 */
export async function createBalanceInvoiceFlow(
  sb: Sb,
  quoteId: string,
  actorId: string | null,
): Promise<BalanceInvoiceOutcome> {
  const quote = await fetchQuoteById(sb, quoteId);
  if (!quote) return { ok: false, error: "Quote not found" };
  if (quote.status !== "accepted") {
    return { ok: false, error: "The quote must be accepted before the final invoice is raised." };
  }
  // Cancelling leaves the quote 'accepted' and only stamps booking_cancelled_at,
  // so the lead page can still render the Final-invoice button on a cancelled
  // job. Every sibling money path checks this (ensureCommitmentInvoice,
  // confirmMoveDate, the bank-feed open-item loader, the post-move sweep); this
  // one did not, so a tidy-up click could raise a REAL Zoho invoice and email it
  // to a customer whose booking was cancelled and whose refund is still pending.
  // Guarded server-side, not just on the button.
  if (quote.booking_cancelled_at) {
    return { ok: false, error: "This booking was cancelled — no final invoice can be raised for it." };
  }
  if (isRealZohoId(quote.zoho_balance_invoice_id)) {
    return {
      ok: false,
      error: `Final invoice ${quote.zoho_balance_invoice_number ?? ""} already exists — it will not be created twice.`.trim(),
    };
  }

  const { agreed, depositCredit, commitmentCredit, forfeited, amount } = await computeBalanceCredits(sb, quote);
  if (amount <= 0) {
    return { ok: false, error: "Nothing left to invoice — payments received cover the agreed price." };
  }

  // Which ledger this raise talks to. Read ONCE per raise and written to the
  // row alongside every id it produces, so a later status poll routes to the
  // system that actually minted the document rather than to whatever the env
  // says today (0109).
  const ledger: LedgerProvider = configuredProvider();
  // Claim the creation slot (NULL → 'pending'); only one caller wins.
  const { data: claimed } = await sb
    .from("quotes")
    .update({ zoho_balance_invoice_id: "pending", balance_invoice_provider: ledger } as never)
    .eq("id", quoteId)
    .is("zoho_balance_invoice_id", null)
    .select("id");
  if (!claimed?.length) {
    return { ok: false, error: "The final invoice is already being created — check again in a moment." };
  }

  const ref = balanceReference(quote.quote_ref);
  // COMMERCIAL: this raise IS the completion invoice (Peter, 2026-08-28 —
  // commercial invoices are raised BY HAND on completion, so this office
  // action is the moment, and there is no automation to add). It falls due on
  // the client's own terms rather than before move day, and that date is what
  // `commercial_due_date` carries.
  //
  // Written HERE, in the same update as the invoice number, because the three
  // readers of the column (classifyBooking, owedNow, /bookings) all key off
  // that number: stamping it in a second write would open a window where the
  // invoice is readable and its terms are not. Nothing wrote this column at
  // all until now, which made `pastTerms` false on every row forever — the
  // overdue state and its internal alert were unreachable code, and a
  // commercial invoice could age indefinitely while the board said "in terms".
  const commercialDueDate =
    policyOfQuote(quote) === "commercial"
      ? paymentTermsDueDate(new Date(), await clientPaymentTermsDays(sb, quote))
      : null;
  try {
    let inv = await findInvoiceByReference(ref); // crash-recovery orphan adoption
    if (inv && !adoptedInvoiceMatches(inv.total, amount)) {
      // An invoice under this reference that bills a DIFFERENT figure was not
      // created by our crashed run — it is Connor's, raised by hand in Zoho.
      // Adopting it binds our record to his number while the customer holds his
      // PDF, so whichever they pay leaves one system wrong. Release and alert.
      await sb
        .from("quotes")
        .update({ zoho_balance_invoice_id: null } as never)
        .eq("id", quoteId)
        .eq("zoho_balance_invoice_id", "pending");
      await sendOpsAlert(`Final invoice NOT adopted — figure mismatch (${quote.quote_ref})`, [
        `An invoice already exists in Zoho under reference <strong>${ref}</strong> for £${(inv.total ?? 0).toFixed(2)}, but ops computed £${amount.toFixed(2)}.`,
        `It was NOT adopted. Reconcile ${inv.invoiceNumber} in Zoho (void it, or correct the figure), then retry.`,
      ], "money").catch(() => {});
      return { ok: false, error: `An invoice for ${ref} already exists in Zoho at a different figure — reconcile it there first.` };
    }
    let contactId = quote.zoho_contact_id;
    let contactProvider = quote.contact_provider;
    if (!inv) {
      // A contact id is reusable only inside the ledger that minted it (0109).
      if (!reusableContactId(contactId, contactProvider, ledger)) {
        contactId = await findOrCreateContact({
          name: quote.customer_name ?? "Customer",
          email: quote.customer_email,
          phone: quote.customer_phone,
          // Keyed on the client, not the name: Xero rejects (or worse, silently
          // adopts) a duplicate contact name. `partyForQuote` logs if it has to
          // fall back to the quote id.
          party: partyForQuote({ id: quote.id, clientId: quote.client_id }),
        });
        contactProvider = ledger;
      }
      const credits = [
        ...(depositCredit > 0 ? [`the £${depositCredit.toFixed(2)} booking deposit`] : []),
        ...(commitmentCredit > 0 ? [`the £${commitmentCredit.toFixed(2)} commitment payment`] : []),
      ];
      const forfeitClause =
        forfeited > 0
          ? ` (£${forfeited.toFixed(2)} previously paid is held against a released move date per the booking terms and does not count toward this balance)`
          : "";
      const creditsClause =
        (credits.length ? ` less ${credits.join(" and ")} already received` : "") + forfeitClause;
      // Same rule as the commitment invoice: card follows the brand's switch,
      // the disclosure follows the brand's identity.
      const notesBrand = await getBrandOrDefault(sb, quote.brand);
      // COMMERCIAL falls due on the client's agreed terms, not before move day
      // — this raise happens AFTER the move. The residential lead sentence told
      // a business client their invoice was already overdue on the day they
      // received it, which is both wrong and the kind of wrong that gets
      // forwarded to an accounts department.
      const commercialInvoice = policyOfQuote(quote) === "commercial";
      const payClause = invoicePayClause(
        notesBrand,
        quote.quote_ref,
        commercialInvoice ? "Payable on your agreed terms, by" : "Payment in full is due before move day, by",
      );
      // The client's own PO, when they issued one. Printed on the invoice
      // because that is the reference their accounts payable matches against —
      // an invoice without it can sit unpaid without anyone treating it as
      // overdue, which is exactly the failure the terms date is meant to catch.
      const po = commercialInvoice ? (quote.po_number ?? "").trim() : "";
      const poClause = po ? ` Your purchase order: ${po}.` : "";
      inv = await createInvoice({
        customerId: contactId!,
        reference: ref,
        description: commercialInvoice
          ? `Removal services — quote ${quote.quote_ref}${po ? ` (PO ${po})` : ""}`
          : `Removal services — quote ${quote.quote_ref}${credits.length ? ` (balance after ${credits.join(" and ")})` : ""}`,
        amount,
        notes: commercialInvoice
          ? `Removal completed, quote ${quote.quote_ref}. Agreed price £${agreed.toFixed(2)}${creditsClause}.${poClause} ${payClause}`
          : `Balance for your move, quote ${quote.quote_ref}. Agreed price £${agreed.toFixed(2)}${creditsClause}. ${payClause}`,
        // The terms date on the DOCUMENT, not only in our own column. Without
        // it the client's accounts department — the one party who has to act on
        // the terms — receives an invoice with no due date at all, while
        // /bookings quietly counts the days. Residential passes nothing and
        // keeps the provider's default.
        ...(commercialDueDate ? { dueDate: commercialDueDate } : {}),
        disableOnlinePayments: true, // balance is BACS/cash only — never card
      });
    }
    // The date everything DOWNSTREAM of this raise is dated by — the lead's
    // balance_due_date and the balance follow-up's due_at. `balanceDueDate`
    // works back from the MOVE, which on a commercial job has already
    // happened: it dated the completion invoice in the past and dropped the
    // follow-up straight into the overdue section of the queue, on the day
    // the invoice was raised and inside the client's terms.
    const dueDate = commercialDueDate ?? balanceDueDate(quote.moving_date);
    await sb
      .from("quotes")
      .update({
        zoho_contact_id: contactId,
        contact_provider: contactProvider,
        zoho_balance_invoice_id: inv.invoiceId,
        balance_invoice_provider: ledger,
        zoho_balance_invoice_number: inv.invoiceNumber,
        zoho_balance_invoice_url: inv.invoiceUrl,
        balance_invoice_amount: amount,
        balance_invoice_created_at: new Date().toISOString(),
        // Conditional so a RESIDENTIAL raise writes byte-identically to before.
        ...(commercialDueDate ? { commercial_due_date: commercialDueDate } : {}),
      } as never)
      .eq("id", quoteId);

    if (quote.lead_id) {
      await sb
        .from("leads")
        .update({ balance_amount: amount, balance_due_date: dueDate } as never)
        .eq("id", quote.lead_id);
      const { data: open } = await sb
        .from("follow_ups")
        .select("id")
        .eq("lead_id", quote.lead_id)
        .eq("reason", "balance")
        .eq("status", "open")
        .limit(1)
        .maybeSingle();
      const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dueDate);
      const dueAt = dm
        ? ukInstant(Number(dm[1]), Number(dm[2]), Number(dm[3]), 9, 0).toISOString()
        : ukTimeAt(9, 0, 1).toISOString();
      if (!open) {
        await sb.from("follow_ups").insert({
          lead_id: quote.lead_id,
          client_id: quote.client_id,
          quote_id: quote.id,
          reason: "balance",
          due_at: dueAt,
          assigned_to: quote.estimator_id,
          source: "balance_invoice",
          metadata: { amount, invoice_number: inv.invoiceNumber },
        } as never);
      }
      await sb.from("activities").insert({
        lead_id: quote.lead_id,
        client_id: quote.client_id,
        actor_id: actorId,
        type: "note",
        summary: `Final invoice ${inv.invoiceNumber} raised — £${amount.toFixed(2)} due before move day`,
        meta: { quote_id: quoteId, invoice_id: inv.invoiceId, amount },
      });
    }

    // Email the customer: branded balance email + Zoho's VAT invoice PDF.
    const emailed = await sendBalanceInvoiceEmail(sb, actorId, quote, {
      invoiceId: inv.invoiceId,
      invoiceNumber: inv.invoiceNumber,
      invoiceUrl: inv.invoiceUrl,
      amount,
    });

    return { ok: true, invoiceNumber: inv.invoiceNumber, amount, emailed };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Zoho balance invoice failed";
    await sb
      .from("quotes")
      .update({ zoho_balance_invoice_id: null } as never)
      .eq("id", quoteId)
      .eq("zoho_balance_invoice_id", "pending");
    if (isLedgerAccessDenied(err)) await reportZohoAccessDenied(sb, { message: msg, while: "balance invoice" });
    else {
      await reportInvoiceRaiseFailed(sb, { message: msg, kind: "balance", quoteRef: quote.quote_ref, reference: ref });
      await sendOpsAlert(`Zoho final invoice FAILED — ${quote.quote_ref}`, [
        `Creating the £${amount.toFixed(2)} balance invoice for <strong>${quote.quote_ref}</strong> failed: ${msg}`,
      ], "system");
    }
    return { ok: false, error: msg };
  }
}

/**
 * Late booking: raise the balance in the same breath as the ask (PRD §3.10
 * Addition 2). Called on every acceptance — it is a no-op for the ordinary
 * booking, whose balance keeps waiting for the T-7 cron.
 *
 * A move inside T-7 already collapses its ask to max(deposit, 25%) in one
 * payment. What did not collapse was the paperwork: the balance waited for the
 * chase cron, which cannot run before 09:00 tomorrow and then waits again for
 * the deposit to be paid and the date confirmed. For a move on Thursday that
 * is a second email days later, sometimes after the move itself. This raises
 * it now, so the customer meets the whole bill in one moment.
 *
 * The eligibility rules — including *why* the customer's contract signature is
 * one of them — live in `lib/payments/late-balance.ts`, pure and tested.
 *
 * Entirely fail-soft, in both directions:
 *  - It never throws. An acceptance that succeeded must not be reported as
 *    failed because a ledger call did; `createBalanceInvoiceFlow` already
 *    alerts ops on a real failure and leaves the column null for the cron to
 *    pick up at T-7, which is exactly today's behaviour.
 *  - A small job (gate 9a — the ask IS the gross) refuses inside the flow with
 *    "nothing left to invoice", before it claims anything. That is the PRD's
 *    "late AND ≤ threshold → the small-job rule wins", and it is silent.
 */
export async function ensureLateBookingBalanceInvoice(
  sb: Sb,
  quoteId: string,
  actorId: string | null,
): Promise<void> {
  try {
    const quote = await fetchQuoteById(sb, quoteId);
    if (!quote) return;
    // Cheap gates first: only read the signature for a booking that could
    // actually qualify, so an ordinary acceptance costs nothing extra.
    if (!lateBalanceDueAtAcceptance(quote, true)) return;
    const { data: signature } = await sb
      .from("signatures")
      .select("id")
      .eq("quote_id", quoteId)
      .eq("kind", "contract")
      .limit(1)
      .maybeSingle();
    if (!lateBalanceDueAtAcceptance(quote, !!signature)) return;

    const res = await createBalanceInvoiceFlow(sb, quoteId, actorId);
    if (res.ok) {
      log.info("quote.late_balance.raised", {
        quoteId,
        quoteRef: quote.quote_ref,
        invoiceNumber: res.invoiceNumber,
        amount: res.amount,
        emailed: res.emailed,
      });
    } else if (/nothing left to invoice/i.test(res.error ?? "")) {
      // The small-job rule already collected the whole job. Nothing to say.
    } else {
      // Not an alert of its own: the flow has already raised the right one for
      // a genuine ledger failure, and the T-7 cron will retry. Logged so a
      // pattern of these is visible rather than inferred from silence.
      log.warn("quote.late_balance.not_raised", {
        quoteId,
        quoteRef: quote.quote_ref,
        reason: res.error,
      });
    }
  } catch (err) {
    log.error("quote.late_balance.failed", { quoteId, ...errorContext(err) });
  }
}

/* ------------------------------------------------------- settle in full */

/** What the customer is offered, and what taking it produced. */
export type SettleInFullOutcome =
  | { ok: true; already: boolean; invoiceNumber: string | null; amount: number }
  | { ok: false; error: string };

/**
 * The customer chose to settle in full at the commitment step (PRD §3.10
 * Addition 3) — raise the T-7 balance invoice NOW, beside the commitment.
 *
 * Two open invoices, individually matchable, and deliberately **no new**
 * `match_kind` and no new invoice suffix: a single bank transfer covering both
 * is the case `lib/bank-feed/whole-quote.ts` already handles — exact pennies
 * against the summed set, offered to the office, never auto-matched.
 *
 * Ignoring the option changes nothing. That is the safety property of the whole
 * feature, so eligibility is a set of gates (`payInFullAvailable`, pure and
 * tested) rather than a preference, and the SAME function decides whether the
 * page offers it. An option the page shows but the server refuses is worse than
 * no option; an action the server accepts without the page offering it is an
 * unguarded money path.
 */
export async function settleQuoteInFull(
  sb: Sb,
  token: string,
  actorId: string | null,
): Promise<SettleInFullOutcome> {
  const quote = await fetchQuoteByToken(sb, token);
  if (!quote) return { ok: false, error: "This link is no longer valid." };

  // Replay / double-tap: the invoice this action exists to create already
  // exists. Report the success it produced rather than an error — the customer
  // tapping twice must not be told something went wrong.
  if (isRealZohoId(quote.zoho_balance_invoice_id)) {
    return {
      ok: true,
      already: true,
      invoiceNumber: quote.zoho_balance_invoice_number,
      amount: Number(quote.balance_invoice_amount ?? 0),
    };
  }

  const { data: lead } = quote.lead_id
    ? await sb
        .from("leads")
        .select("date_confirmed_at, balance_paid_at")
        .eq("id", quote.lead_id)
        .maybeSingle()
    : { data: null };
  if (!payInFullAvailable(quote, lead)) {
    return {
      ok: false,
      error: "This booking can't be settled in full from here — please call 01747 637070.",
    };
  }

  const res = await createBalanceInvoiceFlow(sb, quote.id, actorId);
  if (!res.ok) {
    log.warn("quote.settle_in_full.failed", { quoteId: quote.id, reason: res.error });
    // The ledger failure already alerted ops inside the flow. Say plainly that
    // nothing was raised, rather than leaving the customer to guess whether an
    // invoice is on its way: the commitment they were already asked for still
    // stands, and the balance still raises at T-7 as it always would have.
    return {
      ok: false,
      error: "We couldn't raise the final invoice just now — your commitment payment is unchanged. Please try again shortly or call 01747 637070.",
    };
  }

  if (quote.lead_id) {
    await sb.from("activities").insert({
      lead_id: quote.lead_id,
      client_id: quote.client_id,
      actor_id: actorId,
      type: "note",
      summary: `Customer chose to settle in full at the commitment step — final invoice ${res.invoiceNumber} raised early for £${res.amount.toFixed(2)}`,
      meta: { quote_id: quote.id, invoice_number: res.invoiceNumber, amount: res.amount, via: "pay_in_full" },
    } as never);
  }

  log.info("quote.settle_in_full.raised", {
    quoteId: quote.id,
    quoteRef: quote.quote_ref,
    invoiceNumber: res.invoiceNumber,
    amount: res.amount,
  });
  return { ok: true, already: false, invoiceNumber: res.invoiceNumber, amount: res.amount };
}

/* ------------------------------------------------------------- balance paid */

/** Balance landed (seen in Zoho, or one-tap in ops): stamp the lead, close the
 *  chase, confirm to the customer. Idempotent via the lead's balance_paid_at.
 *  `recordInZoho` records the BACS/cash payment against the balance invoice
 *  (ops one-tap); pass false when Zoho already knows (cron). */
export async function markBalancePaid(
  sb: Sb,
  quoteId: string,
  actorId: string | null,
  recordInZoho = false,
  method: "bank_transfer" | "cash" = "bank_transfer",
): Promise<{ ok: boolean; already?: boolean; error?: string }> {
  const quote = await fetchQuoteById(sb, quoteId);
  if (!quote?.lead_id) return { ok: false, error: "Quote or lead not found" };
  const now = new Date().toISOString();

  // Same rule as the deposit gate: a DB error is a failure, never "already".
  // The method is stamped alongside so /payments can show the rail (Zoho-cron
  // callers default to bank_transfer — Connor records BACS there; cash comes
  // through the office one-tap which passes it explicitly).
  const { data: won, error: gateErr } = await sb
    .from("leads")
    .update({ balance_paid_at: now, balance_paid_method: method } as never)
    .eq("id", quote.lead_id)
    .is("balance_paid_at", null)
    .select("id");
  if (gateErr) return { ok: false, error: gateErr.message };
  if (!won?.length) return { ok: true, already: true };

  // BACS one-tap: keep Connor's Zoho books in step (card/cron already paid).
  if (
    recordInZoho &&
    isRealZohoId(quote.zoho_balance_invoice_id) &&
    isRealZohoId(quote.zoho_contact_id)
  ) {
    try {
      const status = await getInvoiceStatus(quote.zoho_balance_invoice_id, asProvider(quote.balance_invoice_provider));
      if (status.status !== "paid" && status.balance > 0) {
        await recordInvoicePayment(
          {
            customerId: quote.zoho_contact_id,
            invoiceId: quote.zoho_balance_invoice_id,
            amount: status.balance,
            mode: zohoMode(method),
            reference: quote.quote_ref,
          },
          asProvider(quote.balance_invoice_provider),
        );
      }
    } catch (err) {
      await sendOpsAlert(`Zoho balance payment record FAILED — ${quote.quote_ref}`, [
        `The balance for <strong>${quote.quote_ref}</strong> is marked paid in ops, but recording it against ${quote.zoho_balance_invoice_number ?? "the Zoho invoice"} failed: ${err instanceof Error ? err.message : "unknown"}.`,
        `Record the payment manually in Zoho.`,
      ], "system");
    }
  }

  const { data: open } = await sb
    .from("follow_ups")
    .select("id")
    .eq("lead_id", quote.lead_id)
    .eq("reason", "balance")
    .eq("status", "open");
  for (const fu of open ?? []) {
    await sb.from("follow_ups").update({ status: "done", outcome: "paid" }).eq("id", fu.id);
  }

  // The office can set a balance manually ("Set manually" on the follow-up),
  // which writes leads.balance_amount and raises NO Zoho invoice — so
  // quotes.balance_invoice_amount stays null. Reading only the quote copy made
  // this whole block behave as a £0 settlement: the receipt email was suppressed
  // (it is gated on amount > 0), the timeline read "Balance £0 paid — fully
  // settled" and the money alert announced "£0.00 balance received", while
  // /payments showed the real figure. Fall back to the lead's copy.
  let amount = quote.balance_invoice_amount ?? 0;
  if (amount <= 0) {
    const { data: leadBalance } = await sb
      .from("leads")
      .select("balance_amount")
      .eq("id", quote.lead_id)
      .maybeSingle();
    amount = Number(leadBalance?.balance_amount ?? 0);
  }
  await sb.from("activities").insert({
    lead_id: quote.lead_id,
    client_id: quote.client_id,
    actor_id: actorId,
    type: "note",
    summary: `Balance £${amount.toFixed(0)} paid — fully settled`,
    meta: { quote_id: quoteId },
  });

  // Office push notification (best-effort — can never fail the payment).
  await sendPushForEvent(
    paymentPush({ kind: "balance", quoteId, customerName: quote.customer_name, leadId: quote.lead_id }),
    { actorUserId: actorId },
  );

  if (quote.customer_email && amount > 0) {
    const receipt: ReceiptDetails = {
      receiptNumber: balanceReference(quote.quote_ref),
      paidAtLabel: ukReceiptDate(new Date(now)),
      method,
      forLabel: "Final balance",
      amount,
    };
    const brand = await getBrandOrDefault(sb, quote.brand);
    const meta = {
      firstName: quote.customer_name,
      quoteRef: quote.quote_ref,
      amount,
      moveDateLabel: moveDateLabel(quote.moving_date),
      receipt,
      brand,
    };
    const templateId = templateIdFor(brand, "RESEND_TEMPLATE_BALANCE_RECEIPT");
    await dispatchComm(sb, actorId, {
      channel: "email",
      from: accountsFromFor(brand),
      to: quote.customer_email,
      subject: `Payment received — all settled (${quote.quote_ref})`,
      bodyText: `Balance of £${amount.toFixed(2)} received for quote ${quote.quote_ref} — receipt ${receipt.receiptNumber}, paid by ${paymentMethodLabel(method).toLowerCase()} on ${receipt.paidAtLabel}. Nothing more to pay.`,
      ...(templateId
        ? { template: { id: templateId, variables: balanceReceivedTemplateVars(meta) }, bodyHtml: buildBalanceReceivedEmailHtml(meta) }
        : { bodyHtml: buildBalanceReceivedEmailHtml(meta) }),
      replyTo: quote.accept_token ? replyAddressFor(quote.accept_token, brand.name) : undefined,
      leadId: quote.lead_id,
      quoteId: quote.id,
      clientId: quote.client_id ?? undefined,
      brand,
    });
  }

  await sendOpsAlert(`Balance paid — ${quote.quote_ref}`, [
    `£${amount.toFixed(2)} balance received for <strong>${quote.quote_ref}</strong> (${quote.customer_name ?? "customer"}). Fully settled.`,
  ], "money");

  return { ok: true };
}

/* ------------------------------------------------------------- Zoho payment sync */

/**
 * Poll Zoho for card (or manually-recorded) payments on this quote's invoices
 * and run the corresponding paid pipeline. Used by the deposit cron and the
 * accept page (instant confirmation when the customer returns after paying).
 *
 * `stats`, when passed, accumulates across quotes so the caller can tell a quiet
 * sweep from a blind one. The /q page omits it: that read self-heals on the next
 * page load and has a human looking at the result.
 */
export interface ZohoPaymentSync {
  quote: AcceptQuoteRow;
  /** Invoice states this pass TRIED to read. */
  attempted: number;
  /** Of those, how many could NOT be read. */
  unreadable: number;
  /** At least one of those failures was a permanent lock-out, not a blip. */
  accessDenied: boolean;
}

export async function syncZohoPayments(sb: Sb, quote: AcceptQuoteRow): Promise<ZohoPaymentSync> {
  let changed = false;
  // "I could not check" and "nothing has been paid" are DIFFERENT ANSWERS and
  // must never share a rendering. These catches used to be empty, so while Zoho
  // had the integration locked out (2026-08-27) the payment watcher reported
  // `{checked: 9, settled: 0}` every 15 minutes — a clean green that read as
  // "nine invoices checked, none paid" when in truth nine invoices had not been
  // read at all.
  //
  // TWO different escalations come out of this, and they catch different
  // failures — which is why the merge of the two independent fixes keeps both:
  //  - `accessDenied` is the PERMANENT class. One is enough: it will not clear
  //    on the next pass and a human has to act.
  //  - `attempted`/`unreadable` feed the blind-sweep test, which fails a run in
  //    which EVERY read failed even when no single error was classifiable —
  //    a total outage that never returns a recognisable code.
  let attempted = 0;
  let unreadable = 0;
  let accessDenied = false;
  const note = (slot: string, err: unknown) => {
    unreadable++;
    if (isLedgerAccessDenied(err)) accessDenied = true;
    log.warn("ledger.status_read_failed", { quoteId: quote.id, slot, ...errorContext(err) });
  };
  if (isRealZohoId(quote.zoho_deposit_invoice_id) && !quote.deposit_paid_at) {
    try {
      attempted++;
      const s = await getInvoiceStatus(quote.zoho_deposit_invoice_id, asProvider(quote.deposit_invoice_provider));
      if (s.status === "paid") {
        // BACS, not card — same reasoning as the commitment branch below. No
        // Zoho card gateway is active, so an invoice reaching 'paid' in Zoho was
        // recorded by hand (bank transfer or cash); real card money arrives via
        // takepayments and stamps itself with a card_payments row. Recording it
        // as 'card' made buildHeldFromSources treat the money as "already
        // represented by a card row" and skip it entirely, so on cancellation
        // the deposit vanished from the refund queue, the money alert and the
        // customer's cancellation acknowledgement — with nothing flagging it.
        await markDepositPaid(sb, quote.id, { method: "bank_transfer", actorId: null, recordInZoho: false });
        changed = true;
      }
    } catch (err) {
      note("deposit", err);
    }
  }
  if (isRealZohoId(quote.zoho_commitment_invoice_id) && !quote.commitment_paid_at) {
    try {
      attempted++;
      const s = await getInvoiceStatus(quote.zoho_commitment_invoice_id, asProvider(quote.commitment_invoice_provider));
      if (s.status === "paid") {
        // Commitment is BACS/cash only; a payment Connor records in Zoho lands
        // here. Method defaults to bank transfer (cash one-taps record in ops).
        await markCommitmentPaid(sb, quote.id, {
          method: "bank_transfer",
          actorId: null,
          recordInZoho: false,
        });
        changed = true;
      }
    } catch (err) {
      note("commitment", err);
    }
  }
  if (isRealZohoId(quote.zoho_balance_invoice_id) && quote.lead_id) {
    try {
      const { data: lead } = await sb
        .from("leads")
        .select("balance_paid_at")
        .eq("id", quote.lead_id)
        .single();
      if (lead && !lead.balance_paid_at) {
        attempted++;
        const s = await getInvoiceStatus(quote.zoho_balance_invoice_id, asProvider(quote.balance_invoice_provider));
        if (s.status === "paid") {
          await markBalancePaid(sb, quote.id, null);
          changed = true;
        }
      }
    } catch (err) {
      note("balance", err);
    }
  }
  if (accessDenied) await reportZohoAccessDenied(sb, { message: "invoice status unreadable", while: "payment watch" });
  else if (!unreadable && changed) await resolveZohoAccessDenied(sb);
  const after = changed ? ((await fetchQuoteById(sb, quote.id)) ?? quote) : quote;
  return { quote: after, attempted, unreadable, accessDenied };
}
