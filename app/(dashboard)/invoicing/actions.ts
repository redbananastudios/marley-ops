"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getBusinessSettings } from "@/lib/settings";
import { computeBalanceCredits, createBalanceInvoiceFlow, fetchQuoteById } from "@/lib/quote/accept-flow";
import { moveDateLabel } from "@/lib/quote/payments";

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
  const deposit = quote.deposit_amount ?? settings.defaultDeposit;
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
