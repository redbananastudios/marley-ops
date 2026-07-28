"use server";

/**
 * /refunds queue actions (Payments Policy v2 — PRD §5D + §8.10). ALL admin-
 * gated server-side; writes run on the service-role client (refund_queue has
 * no client-side write policy by design). Money-state transitions are
 * single-winner CAS on refund_queue.status / determination — 0 rows means
 * someone else won and side effects are skipped; a DB ERROR is a failure,
 * never "already done".
 *
 * Nothing here creates queue rows (lib/refunds.ts owns that) and nothing
 * refunds money without an explicit button press recorded in executed_by/at.
 */

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { refundCardPayment } from "@/lib/payments/card-payments";
import { reverseDepositVatInZoho } from "@/lib/payments/refund-vat";
import { dispatchComm, sendOpsAlert } from "@/lib/comms/dispatch";
import { accountsAddress, accountsFrom } from "@/lib/comms/sender";
import { replyAddressFor } from "@/lib/quote/chase";
import { ukDayOf } from "@/lib/sales-report";
import { type FillDetermination, type PaymentRail } from "@/lib/payments-policy";
import {
  effectiveDetermination,
  executionForPlan,
  gbpPence,
  notFilledAllowed,
  outstandingSummary,
  parseHeld,
  planForRow,
  TRIGGER_LABELS,
  type CardStateIn,
  type RailView,
} from "@/lib/refunds/queue-view";
import {
  buildRefundExecutedEmailHtml,
  buildRetainedOutcomeEmailHtml,
  refundExecutedTemplateVars,
  retainedOutcomeTemplateVars,
  type RefundLine,
} from "@/lib/comms/refund-emails";

type Sb = SupabaseClient<Database>;
type QueueRow = Database["public"]["Tables"]["refund_queue"]["Row"];

export type RefundActionResult =
  | {
      ok: true;
      already?: boolean;
      /** On `already`: what is ACTUALLY recorded on the row, so a stale tab's
       *  conflicting answer can be surfaced truthfully instead of echoing the
       *  click that lost. */
      recorded?: FillDetermination | null;
    }
  | { ok: false; error: string };

/* ---------------------------------------------------------------- gates */

/** ADMIN only — every queue action moves (or decides) money. */
async function requireAdmin() {
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return null;
  const { data: prof } = await sb
    .from("profiles")
    .select("id, role, active")
    .eq("id", user.id)
    .single();
  if (!prof?.active || prof.role !== "admin") return null;
  return prof;
}

/* -------------------------------------------------------------- helpers */

/** Exact typed-amount confirmation, in pennies. Forgiving of "£"/commas but
 *  never of the value: 1p off is a mismatch. */
function typedMatchesPence(typed: string, expectedPence: number): boolean {
  const n = Number(String(typed).replace(/[£,\s]/g, ""));
  return Number.isFinite(n) && Math.round(n * 100) === expectedPence;
}

async function loadRow(admin: Sb, id: string): Promise<QueueRow | null> {
  const { data } = await admin.from("refund_queue").select("*").eq("id", id).maybeSingle();
  return data ?? null;
}

interface QueueQuote {
  id: string;
  quote_ref: string;
  customer_name: string | null;
  customer_email: string | null;
  lead_id: string | null;
  client_id: string | null;
  accept_token: string | null;
  zoho_contact_id: string | null;
  zoho_deposit_invoice_id: string | null;
  zoho_deposit_invoice_number: string | null;
}

async function loadQuote(admin: Sb, quoteId: string | null): Promise<QueueQuote | null> {
  if (!quoteId) return null;
  const { data } = await admin
    .from("quotes")
    .select(
      "id, quote_ref, customer_name, customer_email, lead_id, client_id, accept_token, zoho_contact_id, zoho_deposit_invoice_id, zoho_deposit_invoice_number",
    )
    .eq("id", quoteId)
    .maybeSingle();
  return (data as QueueQuote | null) ?? null;
}

interface CardStateWithMask extends CardStateIn {
  card_number_mask: string | null;
}

async function loadCardStates(admin: Sb, ids: string[]): Promise<Map<string, CardStateWithMask>> {
  if (!ids.length) return new Map();
  const { data } = await admin
    .from("card_payments")
    .select("id, status, amount_pence, refunded_pence, card_number_mask")
    .in("id", ids);
  return new Map(((data ?? []) as CardStateWithMask[]).map((r) => [r.id, r]));
}

async function loadMarkedRails(admin: Sb, queueId: string): Promise<Set<PaymentRail>> {
  const { data } = await admin
    .from("events_log")
    .select("diff")
    .eq("entity_type", "refund_queue")
    .eq("entity_id", queueId)
    .eq("action", "rail_refunded");
  const set = new Set<PaymentRail>();
  for (const row of data ?? []) {
    const rail = (row.diff as { rail?: string } | null)?.rail;
    if (rail === "bank_transfer" || rail === "cash") set.add(rail);
  }
  return set;
}

/** Recompute the row's execution plan from its FROZEN snapshot + ground truth. */
async function loadExecution(
  admin: Sb,
  row: QueueRow,
  effective: FillDetermination,
): Promise<{ rails: RailView[]; cardStates: Map<string, CardStateWithMask> }> {
  const held = parseHeld(row.held);
  const { rails } = planForRow(held, Math.round(Number(row.conditional_amount) * 100), effective, row.trigger);
  const cardIds = held.map((h) => h.card_payment_id).filter(Boolean) as string[];
  const [cardStates, markedRails] = await Promise.all([
    loadCardStates(admin, cardIds),
    loadMarkedRails(admin, row.id),
  ]);
  return { rails: executionForPlan(rails, cardStates, markedRails), cardStates };
}

const todayUk = (): string => ukDayOf(new Date().toISOString()) ?? new Date().toISOString().slice(0, 10);

function ukDateLabel(day: string | null): string | null {
  if (!day) return null;
  const d = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

const PAYMENT_LABELS: Record<string, string> = {
  deposit: "Deposit",
  commitment: "Commitment payment",
  balance: "Balance",
  "card deposit": "Card deposit",
  "card balance": "Card balance",
};

function customerRailLabel(rail: PaymentRail, cardMask?: string | null): string {
  if (rail === "card") return cardMask ? `back to your card ending ${cardMask.slice(-4)}` : "back to your card";
  if (rail === "cash") return "by bank transfer to your nominated account";
  return "by bank transfer";
}

/** The itemised refund lines for the customer emails (only what was returned). */
function refundLinesFor(
  rails: RailView[],
  cardStates: Map<string, CardStateWithMask>,
): { lines: RefundLine[]; totalPence: number } {
  const lines: RefundLine[] = [];
  let totalPence = 0;
  for (const rail of rails) {
    for (const p of rail.payments) {
      if (p.refundDuePence <= 0) continue;
      const mask = p.cardPaymentId ? cardStates.get(p.cardPaymentId)?.card_number_mask : null;
      lines.push({
        label: PAYMENT_LABELS[p.label] ?? (p.label.charAt(0).toUpperCase() + p.label.slice(1)),
        railLabel: customerRailLabel(p.rail, mask),
        amount: p.refundDuePence / 100,
      });
      totalPence += p.refundDuePence;
    }
  }
  return { lines, totalPence };
}

/** Timeline + audit pair for a queue money-state change. Fail-soft each. */
async function writeQueueTrail(
  admin: Sb,
  row: QueueRow,
  quote: QueueQuote | null,
  actorId: string,
  input: { activityType: "note" | "status_change"; summary: string; action: string; diff: Record<string, unknown> },
): Promise<void> {
  if (row.lead_id) {
    const { error } = await admin.from("activities").insert({
      lead_id: row.lead_id,
      client_id: quote?.client_id ?? null,
      actor_id: actorId,
      type: input.activityType,
      summary: input.summary,
      meta: { refund_queue_id: row.id, ...input.diff } as unknown as Json,
    });
    if (error) {
      await sendOpsAlert(
        "Refund queue update is missing its timeline activity",
        [`refund_queue ${row.id}: "${input.summary}" happened but the lead timeline write failed: ${error.message}`],
        "system",
      );
    }
  }
  const { error: eventError } = await admin.from("events_log").insert({
    actor_id: actorId,
    entity_type: "refund_queue",
    entity_id: row.id,
    action: input.action,
    diff: input.diff as unknown as Json,
  });
  if (eventError) {
    await sendOpsAlert(
      "Refund queue update is missing its audit log entry",
      [`refund_queue ${row.id}: action "${input.action}" happened but the events_log write failed: ${eventError.message}`],
      "system",
    );
  }
}

function revalidateQueueSurfaces(): void {
  revalidatePath("/refunds");
  revalidatePath("/leads", "layout");
  revalidatePath("/payments");
  revalidatePath("/");
}

/* ---------------------------------------------------------- determination */

/**
 * Answer the one human question on a conditional row: did the old day re-book?
 * "Filled" is allowed any time; "Not filled" only once the date has PASSED
 * (UK wall-clock) — the day itself is still bookable.
 */
export async function determineRefundQueueAction(
  id: string,
  determination: "filled" | "not_filled",
): Promise<RefundActionResult> {
  const prof = await requireAdmin();
  if (!prof) return { ok: false, error: "Only admins can decide refunds." };
  if (determination !== "filled" && determination !== "not_filled") {
    return { ok: false, error: "Unknown answer." };
  }

  const admin = createAdminClient();
  const row = await loadRow(admin, id);
  if (!row) return { ok: false, error: "Refund entry not found." };
  const recordedOf = (r: QueueRow): FillDetermination | null =>
    r.determination === "filled" || r.determination === "not_filled"
      ? r.determination
      : effectiveDetermination(r);
  if (row.status !== "pending") return { ok: true, already: true, recorded: recordedOf(row) };
  if (row.trigger === "marley_cancel") {
    return { ok: false, error: "Marley cancellations refund everything — there is no fill question." };
  }
  if (row.determination) return { ok: true, already: true, recorded: recordedOf(row) };
  if (determination === "not_filled" && !notFilledAllowed(row.original_move_date, todayUk())) {
    return {
      ok: false,
      error: `${ukDateLabel(row.original_move_date) ?? "The old date"} hasn't passed yet — the day could still re-book. Answer once it has.`,
    };
  }

  // Single-winner CAS: first answer wins; a racing second answer sees 0 rows.
  const now = new Date().toISOString();
  const { data: claimed, error: casError } = await admin
    .from("refund_queue")
    .update({ determination, determined_by: prof.id, determined_at: now })
    .eq("id", id)
    .eq("status", "pending")
    .is("determination", null)
    .select("id");
  if (casError) return { ok: false, error: casError.message };
  if (!claimed?.length) {
    // Lost the race — report what the WINNER recorded, not what we clicked.
    const again = await loadRow(admin, id);
    return { ok: true, already: true, recorded: again ? recordedOf(again) : null };
  }

  const quote = await loadQuote(admin, row.quote_id);
  const dateLabel = ukDateLabel(row.original_move_date) ?? "the original date";
  const conditional = gbpPence(Math.round(Number(row.conditional_amount) * 100));
  const isDateChange = row.trigger === "customer_date_change";
  await writeQueueTrail(admin, row, quote, prof.id, {
    activityType: "note",
    summary:
      determination === "filled"
        ? isDateChange
          ? `Refund decision — ${dateLabel} re-booked, held money keeps counting toward the new booking`
          : `Refund decision — ${dateLabel} re-booked, everything held becomes refundable`
        : isDateChange
          ? `Refund decision — ${dateLabel} stayed empty, ${conditional} retained and no longer counts toward the new booking`
          : `Refund decision — ${dateLabel} stayed empty, ${conditional} held per the terms`,
    action: "determined",
    diff: { determination, original_move_date: row.original_move_date },
  });

  revalidateQueueSurfaces();
  return { ok: true };
}

/* ------------------------------------------------------------ card refund */

/**
 * Execute ONE card payment's due refund back to its original card. Reuses
 * refundCardPayment verbatim (atomic reserve, same-day void, gateway call,
 * card-side audit + customer receipt). The typed amount is re-verified
 * server-side against BOTH the requested pence and the row's outstanding due
 * for that payment — an exact match or nothing.
 */
export async function executeCardRefundAction(
  id: string,
  paymentId: string,
  amountPence: number,
  typedAmount: string,
): Promise<RefundActionResult> {
  const prof = await requireAdmin();
  if (!prof) return { ok: false, error: "Only admins can issue refunds." };

  const amount = Math.round(Number(amountPence));
  if (!Number.isInteger(amount) || amount <= 0) return { ok: false, error: "Bad amount." };
  if (!typedMatchesPence(typedAmount, amount)) {
    return { ok: false, error: "The typed amount doesn't match — re-type it exactly." };
  }

  const admin = createAdminClient();
  const row = await loadRow(admin, id);
  if (!row) return { ok: false, error: "Refund entry not found." };
  if (row.status !== "pending") return { ok: false, error: "This refund entry is already settled." };
  const effective = effectiveDetermination(row);
  if (!effective) return { ok: false, error: "Answer the re-book question before refunding." };

  const held = parseHeld(row.held);
  if (!held.some((h) => h.card_payment_id === paymentId)) {
    return { ok: false, error: "That card payment isn't part of this refund entry." };
  }
  const { rails } = await loadExecution(admin, row, effective);
  const payment = rails
    .flatMap((r) => r.payments)
    .find((p) => p.cardPaymentId === paymentId);
  if (!payment) return { ok: false, error: "That card payment isn't part of this refund entry." };
  const outstanding = payment.refundDuePence - payment.executedPence;
  if (outstanding <= 0) return { ok: true, already: true };
  if (amount !== outstanding) {
    return {
      ok: false,
      error: `The due refund for this payment is ${gbpPence(outstanding)} — refresh and try again.`,
    };
  }

  const quote = await loadQuote(admin, row.quote_id);
  const res = await refundCardPayment(admin, {
    paymentId,
    amountPence: amount,
    reason: `Refund queue: ${TRIGGER_LABELS[row.trigger] ?? row.trigger} (${quote?.quote_ref ?? row.id.slice(0, 8)})`,
    actorId: prof.id,
  });
  if (!res.ok) return { ok: false, error: res.error };

  // Queue-side audit link (the card side already wrote its own pair inside
  // refundCardPayment). Fail-soft — the money HAS moved.
  const { error: eventError } = await admin.from("events_log").insert({
    actor_id: prof.id,
    entity_type: "refund_queue",
    entity_id: row.id,
    action: "rail_refunded",
    diff: { rail: "card", card_payment_id: paymentId, amount_pence: amount } as unknown as Json,
  });
  if (eventError) {
    await sendOpsAlert(
      "Refund queue card execution is missing its audit entry",
      [`refund_queue ${row.id}: a ${gbpPence(amount)} card refund executed but the events_log write failed: ${eventError.message}`],
      "system",
    );
  }

  revalidateQueueSurfaces();
  return { ok: true };
}

/* -------------------------------------------------------- bank/cash rails */

/**
 * Record a bank or cash rail as paid out (the operator makes the transfer in
 * the bank UI first — the Monzo export carries no account numbers, so bank
 * refunds are keyed off the original payment reference; cash refunds return by
 * bank transfer to a named account collected here). One mark settles the whole
 * rail; the typed amount must equal the rail's full due, exactly.
 */
export async function markRailRefundedAction(
  id: string,
  rail: "bank_transfer" | "cash",
  amountPence: number,
  typedAmount: string,
  cashRecipient?: { name: string; sort: string; account: string },
): Promise<RefundActionResult> {
  const prof = await requireAdmin();
  if (!prof) return { ok: false, error: "Only admins can record refunds." };
  if (rail !== "bank_transfer" && rail !== "cash") return { ok: false, error: "Unknown rail." };

  const amount = Math.round(Number(amountPence));
  if (!Number.isInteger(amount) || amount <= 0) return { ok: false, error: "Bad amount." };
  if (!typedMatchesPence(typedAmount, amount)) {
    return { ok: false, error: "The typed amount doesn't match — re-type it exactly." };
  }

  const admin = createAdminClient();
  const row = await loadRow(admin, id);
  if (!row) return { ok: false, error: "Refund entry not found." };
  if (row.status !== "pending") return { ok: false, error: "This refund entry is already settled." };
  const effective = effectiveDetermination(row);
  if (!effective) return { ok: false, error: "Answer the re-book question before recording refunds." };

  const { rails } = await loadExecution(admin, row, effective);
  const railView = rails.find((r) => r.rail === rail);
  if (!railView || railView.refundDuePence <= 0) {
    return { ok: false, error: "Nothing is due on that rail." };
  }
  if (railView.executed) return { ok: true, already: true };
  if (amount !== railView.refundDuePence) {
    return {
      ok: false,
      error: `The due refund on this rail is ${gbpPence(railView.refundDuePence)} — refresh and try again.`,
    };
  }

  // Cash refunds need somewhere to send the money — captured onto the row
  // before the mark so the record survives with the entry.
  if (rail === "cash") {
    const name = (cashRecipient?.name ?? row.cash_recipient_name ?? "").trim();
    const sort = (cashRecipient?.sort ?? row.cash_recipient_sort ?? "").replace(/[\s-]/g, "");
    const account = (cashRecipient?.account ?? row.cash_recipient_account ?? "").replace(/\s/g, "");
    if (!name || !/^\d{6}$/.test(sort) || !/^\d{6,10}$/.test(account)) {
      return {
        ok: false,
        error: "Cash refunds go back by bank transfer — enter the recipient's name, 6-digit sort code and account number first.",
      };
    }
    const formattedSort = `${sort.slice(0, 2)}-${sort.slice(2, 4)}-${sort.slice(4, 6)}`;
    const { error: recError } = await admin
      .from("refund_queue")
      .update({ cash_recipient_name: name, cash_recipient_sort: formattedSort, cash_recipient_account: account })
      .eq("id", id)
      .eq("status", "pending");
    if (recError) return { ok: false, error: recError.message };
  }

  // The mark IS the money record for this action — an insert error is a
  // failure, never "already done", EXCEPT a 23505 from the 0074 unique index
  // ((entity, rail) for rail_refunded): that means a concurrent press already
  // recorded this exact rail, making the mark single-winner like every other
  // money transition here. The second operator sees "already recorded" and
  // knows to check before making any transfer of their own.
  const { error: markError } = await admin.from("events_log").insert({
    actor_id: prof.id,
    entity_type: "refund_queue",
    entity_id: row.id,
    action: "rail_refunded",
    diff: { rail, amount_pence: amount } as unknown as Json,
  });
  if (markError?.code === "23505") return { ok: true, already: true };
  if (markError) return { ok: false, error: markError.message };

  const quote = await loadQuote(admin, row.quote_id);
  if (row.lead_id) {
    const { error: activityError } = await admin.from("activities").insert({
      lead_id: row.lead_id,
      client_id: quote?.client_id ?? null,
      actor_id: prof.id,
      type: "note",
      summary: `Refund paid out — ${gbpPence(amount)} by ${rail === "cash" ? "bank transfer (cash payment returned)" : "bank transfer"}`,
      meta: { refund_queue_id: row.id, rail, amount_pence: amount } as unknown as Json,
    });
    if (activityError) {
      await sendOpsAlert(
        "Refund queue payout is missing its timeline activity",
        [`refund_queue ${row.id}: a ${gbpPence(amount)} ${rail} payout was recorded but the lead timeline write failed: ${activityError.message}`],
        "system",
      );
    }
  }

  // Automated VAT reversal for the BACS/cash payout just recorded. The money went
  // back BY HAND (this action logs it); this only raises + refunds the Zoho credit
  // note and emails accounts@ to verify. Cash is returned by bank transfer, so both
  // rails record refund_mode "banktransfer". Fail-soft; never blocks the payout.
  if (quote) {
    await reverseDepositVatInZoho(admin, {
      quoteId: quote.id,
      quoteRef: quote.quote_ref,
      zohoContactId: quote.zoho_contact_id,
      zohoDepositInvoiceId: quote.zoho_deposit_invoice_id,
      zohoDepositInvoiceNumber: quote.zoho_deposit_invoice_number,
      customerName: quote.customer_name,
      customerEmail: quote.customer_email,
      leadId: row.lead_id,
      clientId: quote.client_id,
      amountPence: amount,
      mode: "banktransfer",
      voided: false,
      idemKey: `${row.id}-${rail}`,
      // Audit link: record which Zoho credit note reversed this rail (best-effort;
      // must never derail the reversal, so swallow any write failure).
      onCreditNote: async (creditNoteId, creditNoteNumber) => {
        try {
          await admin.from("events_log").insert({
            actor_id: prof.id,
            entity_type: "refund_queue",
            entity_id: row.id,
            action: "credit_note_raised",
            diff: { rail, credit_note_id: creditNoteId, credit_note_number: creditNoteNumber, amount_pence: amount } as unknown as Json,
          });
        } catch {
          /* audit link only; the accounts@ verify email is the primary record */
        }
      },
    });
  }

  revalidateQueueSurfaces();
  return { ok: true };
}

/* -------------------------------------------------------------- complete */

/**
 * Terminal press for refund-everything rows (filled / marley / unconditional):
 * verifies every due rail is executed, CAS-flips the row to `refunded`, and
 * sends the ONE itemised refund-executed email.
 */
export async function completeRefundQueueAction(id: string): Promise<RefundActionResult> {
  const prof = await requireAdmin();
  if (!prof) return { ok: false, error: "Only admins can complete refunds." };

  const admin = createAdminClient();
  const row = await loadRow(admin, id);
  if (!row) return { ok: false, error: "Refund entry not found." };
  if (row.status !== "pending") return { ok: true, already: true };
  const effective = effectiveDetermination(row);
  if (!effective) return { ok: false, error: "Answer the re-book question first." };
  if (effective === "not_filled") {
    return { ok: false, error: "This entry retains money — use Retain to close it." };
  }

  const { rails, cardStates } = await loadExecution(admin, row, effective);
  const outstanding = outstandingSummary(rails);
  if (outstanding) {
    return { ok: false, error: `Still to pay out: ${outstanding}. Execute every rail, then complete.` };
  }

  // A date-change row belongs to a booking that is STILL LIVE: "filled" means
  // the old day re-booked and everything held simply KEEPS counting toward the
  // rebooked job (PRD §1). Nothing pays out, no refund email — the row closes
  // as 'released'. (If the rebooked job later dies, the cancel unwind
  // snapshots afresh and that row handles the money.)
  const isDateChange = row.trigger === "customer_date_change";
  const terminalStatus = isDateChange ? "released" : "refunded";

  // Single-winner CAS — whoever flips pending→terminal sends the email.
  const now = new Date().toISOString();
  const { data: claimed, error: casError } = await admin
    .from("refund_queue")
    .update({ status: terminalStatus, executed_by: prof.id, executed_at: now })
    .eq("id", id)
    .eq("status", "pending")
    .select("id");
  if (casError) return { ok: false, error: casError.message };
  if (!claimed?.length) return { ok: true, already: true };

  const quote = await loadQuote(admin, row.quote_id);

  if (isDateChange) {
    // No customer email: the cancellation-ack already told them everything
    // paid still counts toward the new date — a "refund" email here would be
    // false. Timeline + audit only.
    const heldPence = rails.reduce((s, r) => s + r.heldPence, 0);
    await writeQueueTrail(admin, row, quote, prof.id, {
      activityType: "note",
      summary: `Held money released — ${gbpPence(heldPence)} continues to count toward the rebooked move (${ukDateLabel(row.original_move_date) ?? "original date"} re-booked)`,
      action: "released",
      diff: { held_pence: heldPence, trigger: row.trigger },
    });
    revalidateQueueSurfaces();
    return { ok: true };
  }

  const { lines, totalPence } = refundLinesFor(rails, cardStates);

  // ONE itemised customer email (duplicate-guarded by dispatchComm). Fail-soft:
  // the row is settled either way; a send failure alerts accounts to follow up.
  if (quote?.customer_email && lines.length) {
    const meta = {
      firstName: quote.customer_name,
      quoteRef: quote.quote_ref,
      lines,
      totalRefund: totalPence / 100,
    };
    const templateId = process.env.RESEND_TEMPLATE_REFUND_EXECUTED;
    const sent = await dispatchComm(admin, prof.id, {
      channel: "email",
      from: accountsFrom(),
      to: quote.customer_email,
      subject: `Your ${gbpPence(totalPence)} refund from Marley Moves (${quote.quote_ref})`,
      bodyText: `We have refunded ${gbpPence(totalPence)} for booking ${quote.quote_ref}. Each payment goes back the way it came in. Any questions, call us on 01747 637070.`,
      ...(templateId
        ? { template: { id: templateId, variables: refundExecutedTemplateVars(meta) } }
        : { bodyHtml: buildRefundExecutedEmailHtml(meta) }),
      replyTo: quote.accept_token ? replyAddressFor(quote.accept_token) : accountsAddress(),
      leadId: row.lead_id ?? undefined,
      quoteId: quote.id,
      clientId: quote.client_id ?? undefined,
    });
    if ("ok" in sent && !sent.ok) {
      await sendOpsAlert(
        `Refund completed but the customer email FAILED — ${quote.quote_ref}`,
        [
          `refund_queue ${row.id} is settled (${gbpPence(totalPence)} refunded) but the refund-executed email did not send: ${sent.error}`,
          `Confirm the refund with ${quote.customer_email} another way.`,
        ],
        "money",
      );
    }
  } else if (!quote?.customer_email) {
    await sendOpsAlert(
      `Refund completed with no customer email on file${quote ? ` — ${quote.quote_ref}` : ""}`,
      [`refund_queue ${row.id} is settled (${gbpPence(totalPence)} refunded) but there is no email address to confirm it to.`],
      "money",
    );
  }

  await writeQueueTrail(admin, row, quote, prof.id, {
    activityType: "note",
    summary: `Refund completed — ${gbpPence(totalPence)} returned (${TRIGGER_LABELS[row.trigger] ?? row.trigger})`,
    action: "refunded",
    diff: { refunded_pence: totalPence, trigger: row.trigger },
  });

  revalidateQueueSurfaces();
  return { ok: true };
}

/* ---------------------------------------------------------------- retain */

/**
 * Terminal press for not_filled rows: anything due back (above the 25% held)
 * must already be executed; the retained total is re-typed exactly to arm the
 * button; CAS-flips to `retained` and sends the retained-outcome email
 * ("held against your original date" framing — deliberately no credit note).
 */
export async function retainRefundQueueAction(
  id: string,
  typedConfirm: string,
): Promise<RefundActionResult> {
  const prof = await requireAdmin();
  if (!prof) return { ok: false, error: "Only admins can settle refunds." };

  const admin = createAdminClient();
  const row = await loadRow(admin, id);
  if (!row) return { ok: false, error: "Refund entry not found." };
  if (row.status !== "pending") return { ok: true, already: true };
  if (row.determination !== "not_filled") {
    return { ok: false, error: "Only an entry whose old date stayed empty can be retained." };
  }

  const { rails, cardStates } = await loadExecution(admin, row, "not_filled");
  const retainPence = rails.reduce((s, r) => s + r.retainPence, 0);
  if (retainPence <= 0) {
    return { ok: false, error: "Nothing is held on this entry — complete it as a refund instead." };
  }
  const outstanding = outstandingSummary(rails);
  if (outstanding) {
    return {
      ok: false,
      error: `Refund the amounts above the held 25% first: ${outstanding}.`,
    };
  }
  if (!typedMatchesPence(typedConfirm, retainPence)) {
    return {
      ok: false,
      error: `Type the retained amount exactly (${gbpPence(retainPence)}) to confirm.`,
    };
  }

  const quote = await loadQuote(admin, row.quote_id);
  const dateLbl = ukDateLabel(row.original_move_date) ?? "the original date";

  // Rebook forfeit (PRD §1/§2): on a date-change row the retained slice STOPS
  // counting toward the still-live rebooked job — the queue entry must state
  // the shortfall for the balance adjustment, written atomically with the
  // close so it can never be lost.
  const isDateChange = row.trigger === "customer_date_change";
  const shortfallNote = isDateChange
    ? `${gbpPence(retainPence)} retained against ${dateLbl} no longer counts toward the rebooked job — the balance invoice for ${quote?.quote_ref ?? "this booking"} must be ${gbpPence(retainPence)} higher (the panel excludes it automatically when the balance invoice is raised; adjust manually if it already exists).`
    : null;

  const now = new Date().toISOString();
  const { data: claimed, error: casError } = await admin
    .from("refund_queue")
    .update({
      status: "retained",
      executed_by: prof.id,
      executed_at: now,
      ...(shortfallNote ? { shortfall_note: shortfallNote } : {}),
    })
    .eq("id", id)
    .eq("status", "pending")
    .select("id");
  if (casError) return { ok: false, error: casError.message };
  if (!claimed?.length) return { ok: true, already: true };

  if (shortfallNote) {
    // Money-desk alert: the retained amount must not be re-credited on the
    // rebooked job's balance. Fail-soft — the note on the row is the record.
    await sendOpsAlert(`Rebook shortfall — ${quote?.quote_ref ?? row.id.slice(0, 8)}`, [
      `${gbpPence(retainPence)} retained against ${dateLbl} no longer counts toward the new booking.`,
      `The balance invoice must be ${gbpPence(retainPence)} higher than a simple "agreed minus payments received". The panel excludes the retained amount automatically when the balance invoice is raised from the quote — adjust manually in Zoho if it was already raised.`,
    ], "money");
  }

  const { lines, totalPence: refundedPence } = refundLinesFor(rails, cardStates);

  if (quote?.customer_email) {
    const meta = {
      firstName: quote.customer_name,
      quoteRef: quote.quote_ref,
      originalDateLabel: ukDateLabel(row.original_move_date),
      retainedTotal: retainPence / 100,
      refundLines: lines,
      refundTotal: refundedPence / 100,
    };
    const templateId = process.env.RESEND_TEMPLATE_RETAINED_OUTCOME;
    const sent = await dispatchComm(admin, prof.id, {
      channel: "email",
      from: accountsFrom(),
      to: quote.customer_email,
      subject: `An update on your booking (${quote.quote_ref})`,
      bodyText: `We were not able to re-book your original move date, so ${gbpPence(retainPence)} of what you had paid has been held against that date, as set out in your booking terms.${refundedPence > 0 ? ` ${gbpPence(refundedPence)} above that amount has been refunded in full.` : ""} Any questions, call us on 01747 637070.`,
      ...(templateId
        ? { template: { id: templateId, variables: retainedOutcomeTemplateVars(meta) } }
        : { bodyHtml: buildRetainedOutcomeEmailHtml(meta) }),
      replyTo: quote.accept_token ? replyAddressFor(quote.accept_token) : accountsAddress(),
      leadId: row.lead_id ?? undefined,
      quoteId: quote.id,
      clientId: quote.client_id ?? undefined,
    });
    if ("ok" in sent && !sent.ok) {
      await sendOpsAlert(
        `Retained outcome recorded but the customer email FAILED — ${quote.quote_ref}`,
        [
          `refund_queue ${row.id} is settled (${gbpPence(retainPence)} retained${refundedPence > 0 ? `, ${gbpPence(refundedPence)} refunded` : ""}) but the outcome email did not send: ${sent.error}`,
          `Tell ${quote.customer_email} the outcome another way.`,
        ],
        "money",
      );
    }
  } else {
    await sendOpsAlert(
      `Retained outcome recorded with no customer email on file${quote ? ` — ${quote.quote_ref}` : ""}`,
      [`refund_queue ${row.id} is settled (${gbpPence(retainPence)} retained) but there is no email address to notify.`],
      "money",
    );
  }

  await writeQueueTrail(admin, row, quote, prof.id, {
    activityType: "note",
    summary: `Held money retained — ${gbpPence(retainPence)} held against ${ukDateLabel(row.original_move_date) ?? "the original date"}${refundedPence > 0 ? `; ${gbpPence(refundedPence)} refunded above the held amount` : ""}`,
    action: "retained",
    diff: { retained_pence: retainPence, refunded_pence: refundedPence, trigger: row.trigger },
  });

  revalidateQueueSurfaces();
  return { ok: true };
}
