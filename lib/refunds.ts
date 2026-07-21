/**
 * Refund queue plumbing (Payments Policy v2 — docs/payments-policy-v2-prd.md).
 *
 * Two jobs, pure-core-then-IO-shell like lib/payments/received.ts:
 *
 *  buildHeldSnapshot        what money is ACTUALLY held for a lead right now,
 *                           per rail, read from ground truth: card_payments
 *                           (net of refunds) + the recorded deposit /
 *                           commitment / balance paid stamps. The pure core
 *                           (buildHeldFromSources) is unit-tested without IO.
 *
 *  createRefundQueueEntry   the ONE way a refund_queue row is born (service
 *                           role — RLS has no insert policy by design). Fires
 *                           the accounts@ money alert and writes BOTH the
 *                           lead timeline activity and the events_log audit
 *                           row. Row-insert failure alerts LOUDLY (a cancel
 *                           whose held money silently vanishes from the queue
 *                           is the worst failure mode this system has);
 *                           secondary failures are fail-soft and never abort.
 *
 * Nothing in here refunds money. Execution is a human button on /refunds.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import { sendOpsAlert } from "@/lib/comms/dispatch";
import { log } from "@/lib/log";
import {
  splitHeldMoney,
  type FillDetermination,
  type HeldPayment,
  type HeldSplit,
  type PaymentRail,
} from "@/lib/payments-policy";

type Sb = SupabaseClient<Database>;

/* -------------------------------------------------------------- pure core */

/** The card_payments columns the snapshot needs. */
export interface SnapshotCardRow {
  id: string;
  status: string;
  amount_pence: number;
  refunded_pence: number;
  is_test: boolean;
  kind: string;
  settled_at: string | null;
  created_at: string;
}

/** The money quote (most recently accepted on the lead). */
export interface SnapshotQuote {
  id: string;
  quote_ref: string;
  client_id: string | null;
  customer_name: string | null;
  agreed_price: number | null;
  grand_total: number | null;
  deposit_amount: number | null;
  deposit_paid_at: string | null;
  deposit_paid_method: string | null;
  commitment_invoice_amount: number | null;
  commitment_paid_at: string | null;
  commitment_paid_method: string | null;
  balance_invoice_amount: number | null;
  zoho_deposit_invoice_id: string | null;
  zoho_commitment_invoice_id: string | null;
  zoho_balance_invoice_id: string | null;
}

export interface SnapshotLead {
  id: string;
  name: string | null;
  balance_paid_at: string | null;
  balance_amount: number | null;
}

/** 'pending' is the in-flight claim marker, never a real Zoho id. */
const realZohoId = (v: string | null | undefined): string | null =>
  v && v !== "pending" ? v : null;

/** Recorded (non-card) payment method → refund rail. Balance sends carry no
 *  persisted method today, so they default to bank_transfer (balance is never
 *  card by policy; a cash balance is rare enough for the queue notes). */
const railForMethod = (method: string | null | undefined): PaymentRail =>
  method === "cash" ? "cash" : "bank_transfer";

/** Card gateway states that represent money confirmed held right now.
 *  needs_review is deliberately excluded: the amount mismatch means a human
 *  reconciles it in the MMS first — it joins the snapshot once it's `paid`. */
const CARD_HELD_STATUSES = new Set(["paid", "partially_refunded"]);

const pounds = (pence: number): number => Math.round(pence) / 100;

/**
 * Pure assembly of the held-money list, chronological (first money in first).
 *
 * Dedupe rule (mirrors lib/payments/received.ts): a card-paid deposit ALSO
 * stamps quotes.deposit_paid_at at the same instant, so any recorded stamp
 * whose method is 'card' is the SAME money as its card_payments row and is
 * skipped — the card row (net of refunds) is the single source for card money.
 */
export function buildHeldFromSources(input: {
  cardRows: SnapshotCardRow[];
  quote: SnapshotQuote | null;
  lead: SnapshotLead | null;
}): HeldPayment[] {
  const held: HeldPayment[] = [];

  for (const row of input.cardRows) {
    if (row.is_test) continue;
    if (!CARD_HELD_STATUSES.has(row.status)) continue;
    const netPence = row.amount_pence - row.refunded_pence;
    if (netPence <= 0) continue;
    held.push({
      rail: "card",
      amount: pounds(netPence),
      at: row.settled_at ?? row.created_at,
      label: row.kind === "balance" ? "card balance" : "card deposit",
      card_payment_id: row.id,
    });
  }

  const quote = input.quote;
  if (quote) {
    if (quote.deposit_paid_at && quote.deposit_paid_method !== "card") {
      const amount = Number(quote.deposit_amount ?? 0);
      if (amount > 0) {
        held.push({
          rail: railForMethod(quote.deposit_paid_method),
          amount,
          at: quote.deposit_paid_at,
          label: "deposit",
          zoho_invoice_id: realZohoId(quote.zoho_deposit_invoice_id),
        });
      }
    }
    if (quote.commitment_paid_at && quote.commitment_paid_method !== "card") {
      const amount = Number(quote.commitment_invoice_amount ?? 0);
      if (amount > 0) {
        held.push({
          rail: railForMethod(quote.commitment_paid_method),
          amount,
          at: quote.commitment_paid_at,
          label: "commitment",
          zoho_invoice_id: realZohoId(quote.zoho_commitment_invoice_id),
        });
      }
    }
  }

  const lead = input.lead;
  if (lead?.balance_paid_at) {
    const amount = Number(lead.balance_amount ?? quote?.balance_invoice_amount ?? 0);
    if (amount > 0) {
      held.push({
        rail: "bank_transfer",
        amount,
        at: lead.balance_paid_at,
        label: "balance",
        zoho_invoice_id: realZohoId(quote?.zoho_balance_invoice_id),
      });
    }
  }

  held.sort((a, b) => a.at.localeCompare(b.at));
  return held;
}

/* --------------------------------------------------------------- IO shell */

export interface HeldSnapshot {
  held: HeldPayment[];
  /** The 25%-cap chronological split of `held` against the agreed gross. */
  split: HeldSplit;
  /** VAT-inclusive agreed price the cap was computed from (0 = no accepted quote). */
  grossAgreed: number;
  quote: SnapshotQuote | null;
  lead: SnapshotLead | null;
}

/**
 * Read the ground truth for a lead and assemble the held snapshot. Ground
 * truth = card_payments rows (ALL quotes on the lead — a deposit carried over
 * a supersede keeps its original card row) + the money quote's paid stamps +
 * the lead's balance stamp.
 */
export async function buildHeldSnapshot(sb: Sb, leadId: string): Promise<HeldSnapshot> {
  const [{ data: leadRow }, { data: quoteRow }] = await Promise.all([
    sb.from("leads").select("id, name, balance_paid_at, balance_amount").eq("id", leadId).maybeSingle(),
    sb
      .from("quotes")
      .select(
        "id, quote_ref, client_id, customer_name, agreed_price, grand_total, deposit_amount, deposit_paid_at, deposit_paid_method, commitment_invoice_amount, commitment_paid_at, commitment_paid_method, balance_invoice_amount, zoho_deposit_invoice_id, zoho_commitment_invoice_id, zoho_balance_invoice_id",
      )
      .eq("lead_id", leadId)
      .eq("status", "accepted")
      .order("accepted_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const cardRows = await fetchAllRows<SnapshotCardRow>((from, to) =>
    sb
      .from("card_payments")
      .select("id, status, amount_pence, refunded_pence, is_test, kind, settled_at, created_at")
      .eq("lead_id", leadId)
      .in("status", [...CARD_HELD_STATUSES])
      .order("created_at", { ascending: true })
      .range(from, to),
  );

  const quote = (quoteRow as SnapshotQuote | null) ?? null;
  const lead = (leadRow as SnapshotLead | null) ?? null;
  const held = buildHeldFromSources({ cardRows, quote, lead });
  const grossAgreed = Number(quote?.agreed_price ?? quote?.grand_total ?? 0);
  return { held, split: splitHeldMoney(held, grossAgreed), grossAgreed, quote, lead };
}

/* ------------------------------------------------------------- queue rows */

export type RefundQueueTrigger = "customer_cancel" | "customer_date_change" | "marley_cancel";

export interface CreateRefundQueueInput {
  leadId: string | null;
  quoteId: string | null;
  trigger: RefundQueueTrigger;
  /** Snapshot at trigger time — durable evidence, amounts GBP gross. */
  held: HeldPayment[];
  conditionalAmount: number;
  unconditionalAmount: number;
  /** The day the fill question is about (yyyy-mm-dd). */
  originalMoveDate?: string | null;
  oldAppointmentId?: string | null;
  newAppointmentId?: string | null;
  /** Pre-set when the row never needs the human answer (pre-confirmation
   *  cancels → "filled" semantics: refund everything). marley_cancel rows
   *  leave it null and the /refunds page skips the question. */
  determination?: FillDetermination | null;
  shortfallNote?: string | null;
  notes?: string | null;
  /** Staff actor when office-triggered; null for customer-triggered flows. */
  actorId?: string | null;
  /** Display context for the timeline + accounts@ alert. */
  clientId?: string | null;
  customerName?: string | null;
  quoteRef?: string | null;
}

export type CreateRefundQueueOutcome =
  | { ok: true; id: string }
  | { ok: false; error: string };

const money = (n: number): string => `£${(Number(n) || 0).toFixed(2)}`;

const RAIL_LABEL: Record<PaymentRail, string> = {
  card: "card",
  bank_transfer: "bank transfer",
  cash: "cash",
};

const TRIGGER_LABEL: Record<RefundQueueTrigger, string> = {
  customer_cancel: "customer cancelled",
  customer_date_change: "date change inside 7 days",
  marley_cancel: "Marley cancelled",
};

/**
 * Insert a refund_queue row + alert accounts@ + write the timeline/audit pair.
 * Callers gate single-winner upstream (the cancel/date-change CAS) so exactly
 * one row exists per trigger event.
 */
export async function createRefundQueueEntry(
  sb: Sb,
  input: CreateRefundQueueInput,
): Promise<CreateRefundQueueOutcome> {
  const now = new Date().toISOString();
  const determination = input.determination ?? null;

  const { data: row, error: insertError } = await sb
    .from("refund_queue")
    .insert({
      lead_id: input.leadId,
      quote_id: input.quoteId,
      old_appointment_id: input.oldAppointmentId ?? null,
      new_appointment_id: input.newAppointmentId ?? null,
      original_move_date: input.originalMoveDate ?? null,
      trigger: input.trigger,
      held: input.held as unknown as Json,
      conditional_amount: input.conditionalAmount,
      unconditional_amount: input.unconditionalAmount,
      determination,
      determined_by: determination ? (input.actorId ?? null) : null,
      determined_at: determination ? now : null,
      shortfall_note: input.shortfallNote ?? null,
      notes: input.notes ?? null,
    })
    .select("id")
    .single();

  if (insertError || !row) {
    // LOUD failure — money is held with no queue row tracking it. The cancel
    // flow itself must not abort (fail-soft), but accounts must chase by hand.
    log.error("refund-queue.insert_failed", {
      leadId: input.leadId,
      trigger: input.trigger,
      error: insertError?.message ?? "no row returned",
    });
    await sendOpsAlert(
      "URGENT: refund queue row could NOT be created",
      [
        `A ${TRIGGER_LABEL[input.trigger]} left money held with NO refund-queue row.`,
        `Customer: ${input.customerName ?? "unknown"} · Quote: ${input.quoteRef ?? "unknown"}`,
        `Held: ${money(input.conditionalAmount + input.unconditionalAmount)} (${
          input.held.length
        } payment${input.held.length === 1 ? "" : "s"}).`,
        `Track this refund decision manually. Error: ${insertError?.message ?? "unknown"}`,
      ],
      "money",
    );
    return { ok: false, error: "Could not create the refund queue entry." };
  }

  const total = input.conditionalAmount + input.unconditionalAmount;
  const railLines = input.held.map(
    (p) => `• ${money(p.amount)} by ${RAIL_LABEL[p.rail]}${p.label ? ` (${p.label})` : ""}`,
  );
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";

  // accounts@ money alert — the one notification the deferred-escalation
  // decision kept. Fail-soft (sendOpsAlert never throws).
  await sendOpsAlert(
    `Refund review needed — ${input.customerName ?? "customer"}${
      input.quoteRef ? ` (${input.quoteRef})` : ""
    }`,
    [
      `Trigger: ${TRIGGER_LABEL[input.trigger]}${
        input.originalMoveDate ? ` — original move date ${input.originalMoveDate}` : ""
      }.`,
      `Money held: ${money(total)}.`,
      ...railLines,
      `Held against the date (refunded if it re-books): ${money(input.conditionalAmount)}.`,
      `Refunded regardless: ${money(input.unconditionalAmount)}.`,
      determination
        ? `No fill question needed — ready to execute.`
        : input.trigger === "marley_cancel"
          ? `Marley cancelled — refund everything, no fill question.`
          : `Waiting on the question: did we re-book ${input.originalMoveDate ?? "the old date"}?`,
      `Review: ${appUrl}/refunds`,
    ],
    "money",
  );

  // Timeline + audit pair (money-state change writes BOTH). Fail-soft each.
  if (input.leadId) {
    const { error: activityError } = await sb.from("activities").insert({
      lead_id: input.leadId,
      client_id: input.clientId ?? null,
      actor_id: input.actorId ?? null,
      type: "note",
      summary: `Refund review queued — ${money(total)} held (${TRIGGER_LABEL[input.trigger]})`,
      meta: {
        refund_queue_id: row.id,
        trigger: input.trigger,
        conditional_amount: input.conditionalAmount,
        unconditional_amount: input.unconditionalAmount,
      },
    });
    if (activityError) {
      log.error("refund-queue.activity_failed", { id: row.id, error: activityError.message });
      await sendOpsAlert(
        "Refund queue row is missing its timeline activity",
        [`refund_queue ${row.id} was created but the lead timeline write failed: ${activityError.message}`],
        "system",
      );
    }
  }

  const { error: eventError } = await sb.from("events_log").insert({
    actor_id: input.actorId ?? null,
    entity_type: "refund_queue",
    entity_id: row.id,
    action: "created",
    diff: {
      trigger: input.trigger,
      conditional_amount: input.conditionalAmount,
      unconditional_amount: input.unconditionalAmount,
      held_count: input.held.length,
      determination,
    } as unknown as Json,
  });
  if (eventError) {
    log.error("refund-queue.events_log_failed", { id: row.id, error: eventError.message });
    await sendOpsAlert(
      "Refund queue row is missing its audit log entry",
      [`refund_queue ${row.id} was created but the events_log write failed: ${eventError.message}`],
      "system",
    );
  }

  return { ok: true, id: row.id };
}
