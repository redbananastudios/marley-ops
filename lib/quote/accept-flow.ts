/**
 * Online acceptance + deposit + balance flow core — SERVER ONLY.
 *
 * The lifecycle this file owns:
 *   sent → customer accepts at /q/<token> (typed name) → quote accepted +
 *   lead PROVISIONAL + £deposit Zoho invoice raised → deposit paid (card via
 *   Zoho, or BACS one-tap in ops) → lead CONFIRMED + confirmation email →
 *   pre-move "Final invoice" button → balance Zoho invoice + email →
 *   balance paid → all settled.
 *
 * Invoice idempotency (VAT liability — NEVER create twice): the zoho_*_invoice_id
 * column is claimed with a NULL→'pending' conditional update before any Zoho
 * call; only one caller can win the claim. A crash between Zoho-create and the
 * DB write-back is covered by reference-number orphan adoption (-DEP / -BAL).
 * Customer emails ride the content-hash duplicate guard in dispatchComm.
 */

import { randomBytes } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { getBusinessSettings } from "@/lib/settings";
import { ukTimeAt, ukInstant } from "@/lib/uk-time";
import { dispatchComm, sendOpsAlert } from "@/lib/comms/dispatch";
import {
  buildDepositReceivedEmailHtml,
  buildBalanceInvoiceEmailHtml,
  buildBalanceReceivedEmailHtml,
  depositReceivedTemplateVars,
  balanceInvoiceTemplateVars,
  balanceReceivedTemplateVars,
  type DepositReceivedMeta,
  type BalanceInvoiceMeta,
} from "@/lib/comms/payment-email";
import {
  balanceDue,
  balanceDueDate,
  balanceReference,
  depositReference,
  isAcceptExpired,
  moveDateLabel,
  round2,
} from "@/lib/quote/payments";
import {
  chaseTextToHtml,
  depositChaseEmail,
  expiryLabelFrom,
  replyAddressFor,
} from "@/lib/quote/chase";
import {
  createInvoice,
  findInvoiceByReference,
  findOrCreateContact,
  getInvoicePdfBase64,
  getInvoiceStatus,
  recordInvoicePayment,
  voidInvoice,
} from "@/lib/zoho";

type Sb = SupabaseClient<Database>;

const FUNNEL = ["website_enquiry", "survey_booked", "quoted", "provisional", "confirmed", "completed"];

const QUOTE_COLS =
  "id, quote_ref, status, lead_id, client_id, estimator_id, customer_name, customer_email, customer_phone, collect_addr, dest_addr, moving_date, vat_enabled, grand_total, agreed_price, accepted_at, accept_token, accepted_name, created_at, email_sent_at, deposit_amount, deposit_paid_at, deposit_paid_method, deposit_selfreport_at, declined_at, zoho_contact_id, zoho_deposit_invoice_id, zoho_deposit_invoice_number, zoho_deposit_invoice_url, zoho_deposit_error, zoho_balance_invoice_id, zoho_balance_invoice_number, zoho_balance_invoice_url, balance_invoice_amount, balance_invoice_created_at";

export type AcceptQuoteRow = {
  id: string;
  quote_ref: string;
  status: string;
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
  zoho_deposit_invoice_id: string | null;
  zoho_deposit_invoice_number: string | null;
  zoho_deposit_invoice_url: string | null;
  zoho_deposit_error: string | null;
  zoho_balance_invoice_id: string | null;
  zoho_balance_invoice_number: string | null;
  zoho_balance_invoice_url: string | null;
  balance_invoice_amount: number | null;
  balance_invoice_created_at: string | null;
};

/** A real Zoho id (not unset, not a creation claim in flight). */
const isRealZohoId = (v: string | null): v is string => !!v && v !== "pending";

export async function fetchQuoteByToken(sb: Sb, token: string): Promise<AcceptQuoteRow | null> {
  if (!token || token.length < 10) return null;
  const { data } = await sb.from("quotes").select(QUOTE_COLS).eq("accept_token", token).maybeSingle();
  return (data as AcceptQuoteRow | null) ?? null;
}

export async function fetchQuoteById(sb: Sb, id: string): Promise<AcceptQuoteRow | null> {
  const { data } = await sb.from("quotes").select(QUOTE_COLS).eq("id", id).maybeSingle();
  return (data as AcceptQuoteRow | null) ?? null;
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
          zoho_deposit_invoice_id: old.zoho_deposit_invoice_id,
          zoho_deposit_invoice_number: old.zoho_deposit_invoice_number,
          zoho_deposit_invoice_url: old.zoho_deposit_invoice_url,
        } as never)
        .eq("id", quote.id);
      result.carriedDeposit = true;
    } else if (isRealZohoId(old.zoho_deposit_invoice_id)) {
      // Unpaid deposit invoice on the old number: void it (audit stays in Zoho).
      try {
        await voidInvoice(old.zoho_deposit_invoice_id);
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
        ]);
      }
    }

    // Old balance invoice: re-raised at the new price, so retire the old one.
    if (isRealZohoId(old.zoho_balance_invoice_id)) {
      if (lead?.balance_paid_at) {
        await sendOpsAlert(`Superseded quote has a PAID balance — ${old.quote_ref}`, [
          `${old.quote_ref} was superseded by ${quote.quote_ref}, but its balance invoice ${old.zoho_balance_invoice_number ?? ""} is already paid.`,
          `Nothing was changed in Zoho — settle the price difference manually (credit note or extra invoice).`,
        ]);
      } else {
        try {
          await voidInvoice(old.zoho_balance_invoice_id);
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
          ]);
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

/* ------------------------------------------------------------- accept */

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
): Promise<AcceptOutcome> {
  const quote = await fetchQuoteByToken(sb, token);
  if (!quote) return { ok: false, error: "This quote link is no longer valid." };
  if (quote.status === "accepted") {
    await ensureDepositInvoice(sb, quote.id); // self-heal, then treat as success
    return { ok: true, alreadyAccepted: true };
  }
  if (quote.status !== "sent") return { ok: false, error: "This quote link is no longer valid." };
  if (isAcceptExpired(quote.email_sent_at, quote.created_at)) {
    return { ok: false, error: "This quote has expired. Call us on 01747 637070 for an updated price." };
  }
  const name = fullName.trim();
  if (name.length < 2) return { ok: false, error: "Type your full name to accept the quote." };

  const settings = await getBusinessSettings(sb);
  const agreed = quote.agreed_price ?? Number(quote.grand_total ?? 0);
  const deposit = quote.deposit_amount ?? settings.defaultDeposit;

  const { error } = await sb
    .from("quotes")
    .update({
      status: "accepted",
      accepted_at: new Date().toISOString(),
      accepted_name: name,
      accepted_ip: ip,
      agreed_price: agreed,
      deposit_amount: deposit,
    } as never)
    .eq("id", quote.id)
    .eq("status", "sent"); // double-submit race: only one accept wins
  if (error) return { ok: false, error: "Something went wrong — please call 01747 637070." };

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

  await sendOpsAlert(`Quote ${quote.quote_ref} accepted online`, [
    `<strong>${quote.customer_name ?? "Customer"}</strong> accepted quote <strong>${quote.quote_ref}</strong> (signed "${name}").`,
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
  const deposit =
    typeof depositOverride === "number" && Number.isFinite(depositOverride) && depositOverride > 0
      ? round2(depositOverride)
      : (quote.deposit_amount ?? settings.defaultDeposit);

  if (quote.status === "accepted") {
    await ensureDepositInvoice(sb, quote.id); // self-heal, then no-op
    return {
      ok: true,
      alreadyAccepted: true,
      agreed: quote.agreed_price ?? Number(quote.grand_total ?? 0),
      deposit,
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
    } as never)
    .eq("id", quote.id)
    .in("status", ["draft", "sent"]) // double-tap / online-accept race: one winner
    .select("id");
  if (!won?.length) {
    await ensureDepositInvoice(sb, quote.id);
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
    const patch: Record<string, unknown> = carriedDeposit
      ? {} // deposit already paid on the superseded quote — no new request, no chase
      : {
          deposit_amount: deposit,
          deposit_requested_at: new Date().toISOString(),
          chase_paused: false,
          deposit_chase_step: 0,
        };
    if (lead && FUNNEL.indexOf(lead.status) < FUNNEL.indexOf("provisional")) patch.status = "provisional";
    if (lead && !lead.first_contacted_at) patch.first_contacted_at = new Date().toISOString();
    if (Object.keys(patch).length) await sb.from("leads").update(patch as never).eq("id", quote.lead_id);

    // One open deposit CALL task max — day 5, after the day-1/3 auto reminders.
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
      summary: `Quote ${quote.quote_ref} accepted — agreed £${agreed.toFixed(0)}, ${carriedDeposit ? "deposit already paid (carried over)" : `£${deposit.toFixed(0)} deposit requested`}`,
      meta: { quote_id: quote.id, agreed_price: agreed, via: "staff_accept" },
    });
  }

  if (carriedDeposit) {
    // Fully paid deposit came across with the supersede — nothing to invoice or
    // chase; the caller reports "price revised" rather than "deposit requested".
    return { ok: true, alreadyAccepted: false, agreed, deposit, emailed: false };
  }

  await ensureDepositInvoice(sb, quote.id);

  // Payment instructions to the customer, right now (dup-guarded). Reuses the
  // day-1 reminder copy — sending it here advances the chase to step 1 so the
  // engine's next touch is day 3.
  let emailed = false;
  if (quote.customer_email && token) {
    const email = depositChaseEmail(1, {
      firstName: quote.customer_name,
      quoteRef: quote.quote_ref,
      acceptUrl: acceptUrlFor(token),
      expiryLabel: expiryLabelFrom(quote.email_sent_at, quote.created_at),
    });
    const templateId = process.env.RESEND_TEMPLATE_CHASE_DEPOSIT_1;
    const res = await dispatchComm(sb, actorId, {
      channel: "email",
      to: quote.customer_email,
      subject: email.subject,
      bodyText: email.text,
      ...(templateId
        ? { template: { id: templateId, variables: email.variables } }
        : { bodyHtml: chaseTextToHtml(email.text) }),
      replyTo: replyAddressFor(token),
      from: "Connor at Marley Moves <quotes@marleymoves.co.uk>",
      leadId: quote.lead_id ?? undefined,
      quoteId: quote.id,
      clientId: quote.client_id ?? undefined,
    });
    emailed = "ok" in res && res.ok;
    if (emailed && quote.lead_id) {
      await sb
        .from("leads")
        .update({ deposit_chase_step: 1, deposit_chase_at: new Date().toISOString() } as never)
        .eq("id", quote.lead_id);
    }
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

  const { data: won } = await sb
    .from("quotes")
    .update({
      status: "rejected",
      declined_at: new Date().toISOString(),
      declined_reason: lostReason,
    } as never)
    .eq("id", quote.id)
    .eq("status", "sent")
    .select("id");
  if (!won?.length) return { ok: true }; // raced an accept/decline — the other action stands

  if (quote.lead_id) {
    await sb
      .from("leads")
      .update({
        status: "declined",
        lost_reason: lostReason,
        lost_note: note?.trim() || null,
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
    `<strong>${quote.customer_name ?? "Customer"}</strong> declined quote <strong>${quote.quote_ref}</strong>.`,
    `Reason: ${lostReason.replace(/_/g, " ")}${note?.trim() ? ` — "${note.trim()}"` : ""}.`,
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
    `<strong>${quote.customer_name ?? "Customer"}</strong> reports the £${deposit.toFixed(2)} deposit for <strong>${quote.quote_ref}</strong> was sent by bank transfer.`,
    `Check the bank, then confirm it in Bookings — reminders are paused meanwhile.`,
  ]);

  return { ok: true };
}

/* ------------------------------------------------------------- deposit invoice */

/**
 * Raise the £deposit invoice in Zoho exactly once. Returns the (possibly
 * pre-existing) invoice fields, or null when creation is impossible right now
 * (claim held elsewhere / Zoho down) — callers re-invoke later, it self-heals.
 */
export async function ensureDepositInvoice(sb: Sb, quoteId: string): Promise<AcceptQuoteRow | null> {
  const quote = await fetchQuoteById(sb, quoteId);
  if (!quote || quote.status !== "accepted") return quote;
  if (isRealZohoId(quote.zoho_deposit_invoice_id)) return quote;

  // Claim the creation slot: NULL → 'pending'. Only one caller wins.
  const { data: claimed } = await sb
    .from("quotes")
    .update({ zoho_deposit_invoice_id: "pending" } as never)
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
    let contactId = quote.zoho_contact_id;
    if (!inv) {
      if (!isRealZohoId(contactId)) {
        contactId = await findOrCreateContact({
          name: quote.customer_name ?? "Customer",
          email: quote.customer_email,
          phone: quote.customer_phone,
        });
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
        zoho_deposit_invoice_id: inv.invoiceId,
        zoho_deposit_invoice_number: inv.invoiceNumber,
        zoho_deposit_invoice_url: inv.invoiceUrl,
        zoho_deposit_error: null,
      } as never)
      .eq("id", quoteId);
    return await fetchQuoteById(sb, quoteId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Zoho deposit invoice failed";
    // Release the claim so the next page view / cron pass retries.
    await sb
      .from("quotes")
      .update({ zoho_deposit_invoice_id: null, zoho_deposit_error: msg } as never)
      .eq("id", quoteId)
      .eq("zoho_deposit_invoice_id", "pending");
    await sendOpsAlert(`Zoho deposit invoice FAILED — ${quote.quote_ref}`, [
      `Creating the £${deposit.toFixed(2)} deposit invoice for <strong>${quote.quote_ref}</strong> failed: ${msg}`,
      `The acceptance itself is recorded; the invoice will retry automatically, or raise it manually in Zoho.`,
    ]);
    return await fetchQuoteById(sb, quoteId);
  }
}

/* ------------------------------------------------------------- deposit paid */

export interface DepositPaidOpts {
  method: "bank_transfer" | "card" | "cash";
  actorId: string | null; // null = system (cron / customer card payment)
  /** Record the payment in Zoho too (BACS/cash one-tap). Card payments are
   *  already in Zoho — pass false. */
  recordInZoho: boolean;
}

const zohoMode = (method: string): "banktransfer" | "cash" =>
  method === "cash" ? "cash" : "banktransfer";

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
  const deposit = quote.deposit_amount ?? settings.defaultDeposit;
  const now = new Date().toISOString();

  // Idempotency gate: only the first caller flips deposit_paid_at.
  const { data: won } = await sb
    .from("quotes")
    .update({ deposit_paid_at: now, deposit_paid_method: opts.method } as never)
    .eq("id", quoteId)
    .is("deposit_paid_at", null)
    .select("id");
  if (!won?.length) return { ok: true, already: true };

  // Zoho payment record (BACS path; card is already recorded by Zoho).
  if (
    opts.recordInZoho &&
    isRealZohoId(quote.zoho_deposit_invoice_id) &&
    isRealZohoId(quote.zoho_contact_id)
  ) {
    try {
      const status = await getInvoiceStatus(quote.zoho_deposit_invoice_id);
      if (status.status !== "paid" && status.balance > 0) {
        await recordInvoicePayment({
          customerId: quote.zoho_contact_id,
          invoiceId: quote.zoho_deposit_invoice_id,
          amount: Math.min(deposit, status.balance),
          mode: zohoMode(opts.method),
          reference: quote.quote_ref,
        });
      }
    } catch (err) {
      await sendOpsAlert(`Zoho payment record FAILED — ${quote.quote_ref}`, [
        `The deposit for <strong>${quote.quote_ref}</strong> is marked paid in ops, but recording it against ${quote.zoho_deposit_invoice_number ?? "the Zoho invoice"} failed: ${err instanceof Error ? err.message : "unknown"}.`,
        `Record the payment manually in Zoho.`,
      ]);
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
    await sb.from("leads").update(patch as never).eq("id", quote.lead_id);

    const { data: open } = await sb
      .from("follow_ups")
      .select("id")
      .eq("lead_id", quote.lead_id)
      .eq("reason", "deposit")
      .eq("status", "open");
    for (const fu of open ?? []) {
      await sb.from("follow_ups").update({ status: "done", outcome: "paid" }).eq("id", fu.id);
    }

    await sb.from("activities").insert({
      lead_id: quote.lead_id,
      client_id: lead?.client_id ?? quote.client_id,
      actor_id: opts.actorId,
      type: "status_change",
      summary: `Deposit £${deposit.toFixed(0)} paid (${opts.method === "card" ? "card via Zoho" : "bank transfer"}) — lead Confirmed`,
      meta: { quote_id: quoteId, method: opts.method },
    });
  }

  // Customer confirmation (duplicate-guarded). Prefers the published Resend
  // template (dashboard-editable copy); the in-repo HTML is the fallback.
  if (quote.customer_email) {
    const agreed = quote.agreed_price ?? Number(quote.grand_total ?? 0);
    const meta: DepositReceivedMeta = {
      firstName: quote.customer_name,
      quoteRef: quote.quote_ref,
      amount: deposit,
      moveDateLabel: moveDateLabel(quote.moving_date),
      balanceAmount: balanceDue(agreed, deposit),
    };
    const templateId = process.env.RESEND_TEMPLATE_DEPOSIT_RECEIVED;
    await dispatchComm(sb, opts.actorId, {
      channel: "email",
      to: quote.customer_email,
      subject: `Deposit received — you're booked in (${quote.quote_ref})`,
      bodyText: `Deposit of £${deposit.toFixed(2)} received for quote ${quote.quote_ref}. Your move date is secured.`,
      ...(templateId
        ? { template: { id: templateId, variables: depositReceivedTemplateVars(meta) } }
        : { bodyHtml: buildDepositReceivedEmailHtml(meta) }),
      // Replies route back into the panel (pause chase, log, follow-up).
      replyTo: quote.accept_token ? replyAddressFor(quote.accept_token) : undefined,
      leadId: quote.lead_id ?? undefined,
      quoteId: quote.id,
      clientId: quote.client_id ?? undefined,
    });
  }

  await sendOpsAlert(`Deposit paid — ${quote.quote_ref}`, [
    `£${deposit.toFixed(2)} deposit received for <strong>${quote.quote_ref}</strong> (${quote.customer_name ?? "customer"}) via ${opts.method === "card" ? "card" : "bank transfer"}.`,
    `Lead is now Confirmed and the customer has the confirmation email.`,
  ]);

  return { ok: true };
}

/* ------------------------------------------------------------- balance invoice */

export type BalanceInvoiceOutcome =
  | { ok: true; invoiceNumber: string; amount: number; emailed: boolean }
  | { ok: false; error: string };

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
  if (isRealZohoId(quote.zoho_balance_invoice_id)) {
    return {
      ok: false,
      error: `Final invoice ${quote.zoho_balance_invoice_number ?? ""} already exists — it will not be created twice.`.trim(),
    };
  }

  const settings = await getBusinessSettings(sb);
  const agreed = quote.agreed_price ?? Number(quote.grand_total ?? 0);
  const deposit = quote.deposit_amount ?? settings.defaultDeposit;
  const amount = balanceDue(agreed, deposit);
  if (amount <= 0) return { ok: false, error: "Nothing left to invoice — the deposit covers the agreed price." };

  // Claim the creation slot (NULL → 'pending'); only one caller wins.
  const { data: claimed } = await sb
    .from("quotes")
    .update({ zoho_balance_invoice_id: "pending" } as never)
    .eq("id", quoteId)
    .is("zoho_balance_invoice_id", null)
    .select("id");
  if (!claimed?.length) {
    return { ok: false, error: "The final invoice is already being created — check again in a moment." };
  }

  const ref = balanceReference(quote.quote_ref);
  try {
    let inv = await findInvoiceByReference(ref); // crash-recovery orphan adoption
    let contactId = quote.zoho_contact_id;
    if (!inv) {
      if (!isRealZohoId(contactId)) {
        contactId = await findOrCreateContact({
          name: quote.customer_name ?? "Customer",
          email: quote.customer_email,
          phone: quote.customer_phone,
        });
      }
      inv = await createInvoice({
        customerId: contactId!,
        reference: ref,
        description: `Removal services — quote ${quote.quote_ref} (balance after £${deposit.toFixed(2)} booking deposit)`,
        amount,
        notes: `Balance for your move, quote ${quote.quote_ref}. Agreed price £${agreed.toFixed(2)} less the £${deposit.toFixed(2)} booking deposit already invoiced. Payment in full is due before move day, by bank transfer (reference ${quote.quote_ref}) or cash.`,
        disableOnlinePayments: true, // balance is BACS/cash only — never card
      });
    }
    const dueDate = balanceDueDate(quote.moving_date);
    await sb
      .from("quotes")
      .update({
        zoho_contact_id: contactId,
        zoho_balance_invoice_id: inv.invoiceId,
        zoho_balance_invoice_number: inv.invoiceNumber,
        zoho_balance_invoice_url: inv.invoiceUrl,
        balance_invoice_amount: amount,
        balance_invoice_created_at: new Date().toISOString(),
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
    let emailed = false;
    if (quote.customer_email) {
      let pdfBase64: string | undefined;
      try {
        pdfBase64 = await getInvoicePdfBase64(inv.invoiceId);
      } catch {
        pdfBase64 = undefined; // send without the attachment rather than not at all
      }
      const meta: BalanceInvoiceMeta = {
        firstName: quote.customer_name,
        quoteRef: quote.quote_ref,
        amount,
        moveDateLabel: moveDateLabel(quote.moving_date),
        invoiceUrl: inv.invoiceUrl,
        invoiceNumber: inv.invoiceNumber,
      };
      const templateId = process.env.RESEND_TEMPLATE_BALANCE_INVOICE;
      const res = await dispatchComm(sb, actorId, {
        channel: "email",
        to: quote.customer_email,
        subject: `Your final balance — ${quote.quote_ref} (£${amount.toFixed(2)})`,
        bodyText: `Final balance of £${amount.toFixed(2)} for quote ${quote.quote_ref} (invoice ${inv.invoiceNumber}). Payment in full is due before move day.`,
        ...(templateId
          ? { template: { id: templateId, variables: balanceInvoiceTemplateVars(meta) } }
          : { bodyHtml: buildBalanceInvoiceEmailHtml(meta) }),
        attachmentBase64: pdfBase64,
        attachmentName: pdfBase64 ? `MarleyMoves-Invoice-${inv.invoiceNumber}.pdf` : undefined,
        replyTo: quote.accept_token ? replyAddressFor(quote.accept_token) : undefined,
        leadId: quote.lead_id ?? undefined,
        quoteId: quote.id,
        clientId: quote.client_id ?? undefined,
      });
      emailed = "ok" in res && res.ok;
    }

    return { ok: true, invoiceNumber: inv.invoiceNumber, amount, emailed };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Zoho balance invoice failed";
    await sb
      .from("quotes")
      .update({ zoho_balance_invoice_id: null } as never)
      .eq("id", quoteId)
      .eq("zoho_balance_invoice_id", "pending");
    await sendOpsAlert(`Zoho final invoice FAILED — ${quote.quote_ref}`, [
      `Creating the £${amount.toFixed(2)} balance invoice for <strong>${quote.quote_ref}</strong> failed: ${msg}`,
    ]);
    return { ok: false, error: msg };
  }
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

  const { data: won } = await sb
    .from("leads")
    .update({ balance_paid_at: now } as never)
    .eq("id", quote.lead_id)
    .is("balance_paid_at", null)
    .select("id");
  if (!won?.length) return { ok: true, already: true };

  // BACS one-tap: keep Connor's Zoho books in step (card/cron already paid).
  if (
    recordInZoho &&
    isRealZohoId(quote.zoho_balance_invoice_id) &&
    isRealZohoId(quote.zoho_contact_id)
  ) {
    try {
      const status = await getInvoiceStatus(quote.zoho_balance_invoice_id);
      if (status.status !== "paid" && status.balance > 0) {
        await recordInvoicePayment({
          customerId: quote.zoho_contact_id,
          invoiceId: quote.zoho_balance_invoice_id,
          amount: status.balance,
          mode: zohoMode(method),
          reference: quote.quote_ref,
        });
      }
    } catch (err) {
      await sendOpsAlert(`Zoho balance payment record FAILED — ${quote.quote_ref}`, [
        `The balance for <strong>${quote.quote_ref}</strong> is marked paid in ops, but recording it against ${quote.zoho_balance_invoice_number ?? "the Zoho invoice"} failed: ${err instanceof Error ? err.message : "unknown"}.`,
        `Record the payment manually in Zoho.`,
      ]);
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

  const amount = quote.balance_invoice_amount ?? 0;
  await sb.from("activities").insert({
    lead_id: quote.lead_id,
    client_id: quote.client_id,
    actor_id: actorId,
    type: "note",
    summary: `Balance £${amount.toFixed(0)} paid — fully settled`,
    meta: { quote_id: quoteId },
  });

  if (quote.customer_email && amount > 0) {
    const meta = {
      firstName: quote.customer_name,
      quoteRef: quote.quote_ref,
      amount,
      moveDateLabel: moveDateLabel(quote.moving_date),
    };
    const templateId = process.env.RESEND_TEMPLATE_BALANCE_RECEIVED;
    await dispatchComm(sb, actorId, {
      channel: "email",
      to: quote.customer_email,
      subject: `Payment received — all settled (${quote.quote_ref})`,
      bodyText: `Balance of £${amount.toFixed(2)} received for quote ${quote.quote_ref}. Nothing more to pay.`,
      ...(templateId
        ? { template: { id: templateId, variables: balanceReceivedTemplateVars(meta) } }
        : { bodyHtml: buildBalanceReceivedEmailHtml(meta) }),
      replyTo: quote.accept_token ? replyAddressFor(quote.accept_token) : undefined,
      leadId: quote.lead_id,
      quoteId: quote.id,
      clientId: quote.client_id ?? undefined,
    });
  }

  await sendOpsAlert(`Balance paid — ${quote.quote_ref}`, [
    `£${amount.toFixed(2)} balance received for <strong>${quote.quote_ref}</strong> (${quote.customer_name ?? "customer"}). Fully settled.`,
  ]);

  return { ok: true };
}

/* ------------------------------------------------------------- Zoho payment sync */

/**
 * Poll Zoho for card (or manually-recorded) payments on this quote's invoices
 * and run the corresponding paid pipeline. Used by the deposit cron and the
 * accept page (instant confirmation when the customer returns after paying).
 */
export async function syncZohoPayments(sb: Sb, quote: AcceptQuoteRow): Promise<AcceptQuoteRow> {
  let changed = false;
  if (isRealZohoId(quote.zoho_deposit_invoice_id) && !quote.deposit_paid_at) {
    try {
      const s = await getInvoiceStatus(quote.zoho_deposit_invoice_id);
      if (s.status === "paid") {
        await markDepositPaid(sb, quote.id, { method: "card", actorId: null, recordInZoho: false });
        changed = true;
      }
    } catch {
      /* Zoho unreachable — next pass catches it */
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
        const s = await getInvoiceStatus(quote.zoho_balance_invoice_id);
        if (s.status === "paid") {
          await markBalancePaid(sb, quote.id, null);
          changed = true;
        }
      }
    } catch {
      /* next pass */
    }
  }
  return changed ? ((await fetchQuoteById(sb, quote.id)) ?? quote) : quote;
}
