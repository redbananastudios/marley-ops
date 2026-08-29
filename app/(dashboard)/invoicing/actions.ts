"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getBusinessSettings } from "@/lib/settings";
import {
  canResendInvoiceNow,
  computeBalanceCredits,
  createBalanceInvoiceFlow,
  fetchQuoteById,
  resendBalanceInvoiceFlow,
  resendCommitmentInvoiceFlow,
  resendDepositInvoiceFlow,
  type ResendRail,
} from "@/lib/quote/accept-flow";
import { moveDateLabel } from "@/lib/quote/payments";
import { depositOfQuote } from "@/lib/payments-policy";

/**
 * Final (balance) invoice actions — the manual pre-move trigger. Peter's hard
 * rule: an invoice must NEVER be created or sent twice (VAT liability). The
 * flow core enforces that with a DB claim + Zoho reference adoption; these
 * actions only add auth + the info the confirm dialog shows.
 */

export interface BalanceInvoiceInfo {
  ok: true;
  quoteId: string;
  quoteRef: string;
  customerName: string | null;
  customerEmail: string | null;
  moveDateLabel: string | null;
  agreedPrice: number;
  depositAmount: number;
  depositPaid: boolean;
  amountDue: number;
  /** Already-created invoice, if any — the dialog shows this instead of a confirm. */
  invoiceNumber: string | null;
  invoiceUrl: string | null;
  invoiceAmount: number | null;
  balancePaid: boolean;
}

export type BalanceInvoiceInfoResult = BalanceInvoiceInfo | { ok: false; error: string };

/** Everything the confirm dialog needs, from the lead's latest accepted quote. */
export async function getBalanceInvoiceInfo(leadId: string): Promise<BalanceInvoiceInfoResult> {
  const sb = await createClient();
  const { data: q } = await sb
    .from("quotes")
    .select("id")
    .eq("lead_id", leadId)
    .eq("status", "accepted")
    .order("accepted_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!q) return { ok: false, error: "No accepted quote on this job yet — accept a quote first." };

  const quote = await fetchQuoteById(sb, q.id);
  if (!quote) return { ok: false, error: "Quote not found" };
  const settings = await getBusinessSettings(sb);
  // Policy-aware, matching computeBalanceCredits below. The office dialog
  // prints "agreed £X less £Y", and Y must be the figure the invoice actually
  // credits — a raw `?? defaultDeposit` turns a commercial quote's null column
  // into £100 and shows the office a short figure the invoice will not use.
  const deposit = depositOfQuote(quote, settings.defaultDeposit);
  // Same computation the flow uses — the figure the office approves in the
  // dialog must be the figure that lands in Zoho (deposit + raised commitment
  // carved out, retained rebook forfeits added back).
  const credits = await computeBalanceCredits(sb, quote);

  const { data: lead } = await sb
    .from("leads")
    .select("balance_paid_at")
    .eq("id", leadId)
    .maybeSingle();

  return {
    ok: true,
    quoteId: quote.id,
    quoteRef: quote.quote_ref,
    customerName: quote.customer_name,
    customerEmail: quote.customer_email,
    moveDateLabel: moveDateLabel(quote.moving_date),
    agreedPrice: credits.agreed,
    depositAmount: deposit,
    depositPaid: !!quote.deposit_paid_at,
    amountDue: quote.balance_invoice_amount ?? credits.amount,
    invoiceNumber:
      quote.zoho_balance_invoice_id && quote.zoho_balance_invoice_id !== "pending"
        ? quote.zoho_balance_invoice_number
        : null,
    invoiceUrl: quote.zoho_balance_invoice_url,
    invoiceAmount: quote.balance_invoice_amount,
    balancePaid: !!lead?.balance_paid_at,
  };
}

/**
 * Send an already-raised final invoice again — same number, same figure, same
 * PDF. For the customer who wants to settle up now rather than wait for the
 * chase. Creating a second invoice stays impossible; the flow refuses once the
 * balance is paid.
 */
export async function resendBalanceInvoiceAction(quoteId: string) {
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { ok: false as const, error: "Not signed in" };

  const res = await resendBalanceInvoiceFlow(sb, quoteId, user.id);
  if (res.ok) {
    const quote = await fetchQuoteById(sb, quoteId);
    if (quote?.lead_id) revalidatePath(`/leads/${quote.lead_id}`);
    revalidatePath(`/quotes/${quoteId}`);
  }
  return res;
}

/* ------------------------------------------------ deposit / commitment rails */

/**
 * What the "send it again" dialog shows for the deposit and commitment rails.
 * Neither rail has a CREATE action here — the deposit invoice is raised by
 * acceptance and the commitment by date confirmation — so this is purely
 * "which invoice, how much, to whom, and may it go".
 */
export interface InvoiceResendInfo {
  ok: true;
  rail: ResendRail;
  quoteId: string;
  quoteRef: string;
  customerName: string | null;
  customerEmail: string | null;
  invoiceNumber: string | null;
  invoiceUrl: string | null;
  amount: number;
  /** Null when the server would send it; the server's own refusal otherwise —
   *  the SAME verdict the action applies, so the dialog can never offer a send
   *  the server will reject (or hide one it would allow). */
  blockedReason: string | null;
}

export type InvoiceResendInfoResult = InvoiceResendInfo | { ok: false; error: string };

/** Everything the re-send dialog needs, from the lead's latest accepted quote. */
export async function getInvoiceResendInfo(
  leadId: string,
  rail: ResendRail,
): Promise<InvoiceResendInfoResult> {
  const sb = await createClient();
  const { data: q } = await sb
    .from("quotes")
    .select("id")
    .eq("lead_id", leadId)
    .eq("status", "accepted")
    .order("accepted_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!q) return { ok: false, error: "No accepted quote on this job yet — accept a quote first." };

  const quote = await fetchQuoteById(sb, q.id);
  if (!quote) return { ok: false, error: "Quote not found" };

  const verdict = await canResendInvoiceNow(sb, quote, rail);

  return {
    ok: true,
    rail,
    quoteId: quote.id,
    quoteRef: quote.quote_ref,
    customerName: quote.customer_name,
    customerEmail: quote.customer_email,
    invoiceNumber:
      rail === "deposit" ? quote.zoho_deposit_invoice_number : quote.zoho_commitment_invoice_number,
    invoiceUrl: rail === "deposit" ? quote.zoho_deposit_invoice_url : quote.zoho_commitment_invoice_url,
    // The stored figure, never a settings fallback: the dialog must show the
    // number the guard judged, so "£100" and "the deposit amount is not
    // recorded" can never appear side by side.
    amount:
      rail === "deposit"
        ? Number(quote.deposit_amount ?? 0)
        : Number(quote.commitment_invoice_amount ?? 0),
    blockedReason: verdict.ok ? null : verdict.reason,
  };
}

/**
 * Send an already-raised deposit or commitment invoice again — same figure,
 * same invoice, nothing created. The flow re-checks its own guard, so a
 * customer who pays while the dialog is open is refused by the server.
 */
export async function resendInvoiceAction(quoteId: string, rail: ResendRail) {
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { ok: false as const, error: "Not signed in" };

  const res =
    rail === "deposit"
      ? await resendDepositInvoiceFlow(sb, quoteId, user.id)
      : await resendCommitmentInvoiceFlow(sb, quoteId, user.id);
  if (res.ok) {
    const quote = await fetchQuoteById(sb, quoteId);
    if (quote?.lead_id) revalidatePath(`/leads/${quote.lead_id}`);
    revalidatePath(`/quotes/${quoteId}`);
    revalidatePath("/bookings");
  }
  return res;
}

/** Create + email the final invoice (idempotent — see accept-flow). */
export async function createBalanceInvoiceAction(quoteId: string) {
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { ok: false as const, error: "Not signed in" };

  const res = await createBalanceInvoiceFlow(sb, quoteId, user.id);
  if (res.ok) {
    const quote = await fetchQuoteById(sb, quoteId);
    if (quote?.lead_id) revalidatePath(`/leads/${quote.lead_id}`);
    revalidatePath(`/quotes/${quoteId}`);
    revalidatePath("/follow-ups");
  }
  return res;
}
