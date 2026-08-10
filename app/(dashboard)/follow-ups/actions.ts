"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { ukInstant, ukTimeAt } from "@/lib/uk-time";
import { markBalancePaid, markDepositPaid } from "@/lib/quote/accept-flow";

/** Follow-up work-queue actions. Manual-first: every mutation is a human tap, every
 *  tap lands in the lead's activity log. Escalation is advisory only (never auto-lost). */

const REASONS = ["no_answer", "quote_followup", "deposit", "balance", "custom"] as const;
const OUTCOMES = ["reached", "no_answer", "no_answer_exhausted", "paid", "declined", "cancelled"] as const;
export type FollowUpReason = (typeof REASONS)[number];
export type FollowUpOutcome = (typeof OUTCOMES)[number];

const REASON_LABEL: Record<FollowUpReason, string> = {
  no_answer: "No answer",
  quote_followup: "Quote follow-up",
  deposit: "Deposit",
  balance: "Balance",
  custom: "Follow-up",
};

async function ctx() {
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  return { sb, userId: user?.id ?? null };
}

function refresh(leadId?: string | null) {
  revalidatePath("/follow-ups");
  revalidatePath("/");
  if (leadId) revalidatePath(`/leads/${leadId}`);
}

/** Tomorrow 09:00 UK — the standard "try again in the morning" requeue slot. */
function tomorrowMorning(): string {
  return ukTimeAt(9, 0, 1).toISOString();
}

const createSchema = z.object({
  leadId: z.string().uuid(),
  reason: z.enum(REASONS),
  dueAt: z.string().min(1),
  notes: z.string().trim().optional(),
  assignedTo: z.string().uuid().nullable().optional(),
  quoteId: z.string().uuid().nullable().optional(),
});

export async function createFollowUpAction(input: z.infer<typeof createSchema>) {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { sb, userId } = await ctx();
  const v = parsed.data;

  const { data: lead } = await sb.from("leads").select("client_id").eq("id", v.leadId).single();
  const { data, error } = await sb
    .from("follow_ups")
    .insert({
      lead_id: v.leadId,
      client_id: lead?.client_id ?? null,
      quote_id: v.quoteId ?? null,
      reason: v.reason,
      due_at: new Date(v.dueAt).toISOString(),
      assigned_to: v.assignedTo ?? userId,
      created_by: userId,
      notes: v.notes || null,
    })
    .select("id")
    .single();
  if (error) return { ok: false as const, error: error.message };

  await sb.from("activities").insert({
    lead_id: v.leadId,
    client_id: lead?.client_id ?? null,
    actor_id: userId,
    type: "note",
    summary: `${REASON_LABEL[v.reason]} follow-up created`,
    meta: { follow_up_id: data.id, due_at: v.dueAt },
  });
  refresh(v.leadId);
  return { ok: true as const, id: data.id };
}

/**
 * The one-tap "No reply": attempt +1, stamp last_attempt_at, requeue for tomorrow
 * morning, log the attempt. Never touches first_contacted_at — an attempt is not
 * contact, so the response-time metric stays honest.
 */
export async function logNoReplyAction(id: string) {
  const { sb, userId } = await ctx();
  const { data: fu } = await sb
    .from("follow_ups")
    .select("lead_id, client_id, attempt_count, reason")
    .eq("id", id)
    .single();
  if (!fu) return { ok: false as const, error: "Follow-up not found" };

  const attempts = (fu.attempt_count ?? 0) + 1;
  const { error } = await sb
    .from("follow_ups")
    .update({ attempt_count: attempts, last_attempt_at: new Date().toISOString(), due_at: tomorrowMorning() })
    .eq("id", id);
  if (error) return { ok: false as const, error: error.message };

  await sb.from("activities").insert({
    lead_id: fu.lead_id,
    client_id: fu.client_id,
    actor_id: userId,
    type: "call",
    summary: `Contact attempt ${attempts} — no reply (re-queued for tomorrow)`,
    meta: { follow_up_id: id, attempt: attempts },
  });
  refresh(fu.lead_id);
  return { ok: true as const, attempts };
}

/** Create-or-bump a lead's no-answer follow-up (the lead-card / action-bar entry point). */
export async function noReplyForLeadAction(leadId: string) {
  const { sb } = await ctx();
  const { data: existing } = await sb
    .from("follow_ups")
    .select("id")
    .eq("lead_id", leadId)
    .eq("reason", "no_answer")
    .eq("status", "open")
    .limit(1)
    .maybeSingle();

  if (existing) return logNoReplyAction(existing.id);
  const created = await createFollowUpAction({ leadId, reason: "no_answer", dueAt: tomorrowMorning() });
  if (!created.ok) return created;
  return logNoReplyAction(created.id);
}

export async function completeFollowUpAction(id: string, outcome: FollowUpOutcome, notes?: string) {
  if (!OUTCOMES.includes(outcome)) return { ok: false as const, error: "Invalid outcome" };
  const { sb, userId } = await ctx();
  const { data: fu } = await sb.from("follow_ups").select("lead_id, client_id, reason, notes").eq("id", id).single();
  if (!fu) return { ok: false as const, error: "Follow-up not found" };

  const { error } = await sb
    .from("follow_ups")
    .update({ status: "done", outcome, notes: notes?.trim() ? notes.trim() : fu.notes })
    .eq("id", id);
  if (error) return { ok: false as const, error: error.message };

  await sb.from("activities").insert({
    lead_id: fu.lead_id,
    client_id: fu.client_id,
    actor_id: userId,
    type: "note",
    summary: `${REASON_LABEL[fu.reason as FollowUpReason]} follow-up closed — ${outcome.replace(/_/g, " ")}`,
    meta: { follow_up_id: id, outcome },
  });
  refresh(fu.lead_id);
  return { ok: true as const };
}

export async function snoozeFollowUpAction(id: string, dueAt: string) {
  const when = new Date(dueAt);
  if (Number.isNaN(when.getTime())) return { ok: false as const, error: "Invalid date" };
  const { sb } = await ctx();
  const { data: fu, error } = await sb
    .from("follow_ups")
    .update({ due_at: when.toISOString() })
    .eq("id", id)
    .select("lead_id")
    .single();
  if (error) return { ok: false as const, error: error.message };
  refresh(fu?.lead_id);
  return { ok: true as const };
}

/**
 * Close a "raise a Zoho credit note by hand" task by recording the number.
 *
 * That task only exists because the automated VAT reversal failed, so
 * `card_payments.zoho_credit_note_id` never filled and nothing could ever close
 * it — it sat on the board forever. A bare tick would close the task and leave
 * the column empty, so the app and the books would still disagree. Recording the
 * number does both jobs at once.
 */
export async function recordCreditNoteAction(id: string, creditNoteNumber: string) {
  const ref = creditNoteNumber.trim();
  if (!ref) return { ok: false as const, error: "Enter the Zoho credit note number" };
  const { sb, userId } = await ctx();

  const { data: fu } = await sb
    .from("follow_ups")
    .select("id, lead_id, client_id, quote_id, reason, source, metadata, status")
    .eq("id", id)
    .maybeSingle();
  if (!fu) return { ok: false as const, error: "That follow-up no longer exists" };
  const kind = (fu.metadata as { kind?: string } | null)?.kind;
  if (fu.reason !== "custom" || fu.source !== "card_payment" || kind !== "credit_note") {
    return { ok: false as const, error: "That isn't a credit-note task" };
  }

  // Write it back to the card payment so the refund record carries the note —
  // best-effort: the task closing is what the office is waiting on, and a quote
  // can legitimately have no card payment (a bank-transfer refund).
  if (fu.quote_id) {
    const { error: cpError } = await sb
      .from("card_payments")
      .update({ zoho_credit_note_number: ref })
      .eq("quote_id", fu.quote_id)
      .is("zoho_credit_note_number", null);
    if (cpError) {
      return { ok: false as const, error: `Could not record it against the payment: ${cpError.message}` };
    }
  }

  const { error } = await sb
    .from("follow_ups")
    .update({ status: "done", outcome: "reached" })
    .eq("id", id)
    .eq("status", "open"); // CAS — don't reopen one someone already closed
  if (error) return { ok: false as const, error: error.message };

  await sb.from("activities").insert({
    lead_id: fu.lead_id,
    client_id: fu.client_id,
    actor_id: userId,
    type: "note",
    summary: `Zoho credit note ${ref} recorded — VAT reversal closed`,
    meta: { follow_up_id: id, credit_note_number: ref },
  });
  refresh(fu.lead_id);
  return { ok: true as const };
}

export async function cancelFollowUpAction(id: string) {
  const { sb } = await ctx();
  const { data: fu, error } = await sb
    .from("follow_ups")
    .update({ status: "cancelled", outcome: "cancelled" })
    .eq("id", id)
    .select("lead_id")
    .single();
  if (error) return { ok: false as const, error: error.message };
  refresh(fu?.lead_id);
  return { ok: true as const };
}

/* ---------------- Payments (Phase 1 — manual state on the lead) ---------------- */

/** Mark the deposit requested: stamps it, records the amount, and opens a deposit
 *  chase due tomorrow (one open chase max). */
export async function requestDepositAction(leadId: string, amount: number) {
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false as const, error: "Enter a deposit amount" };
  const { sb, userId } = await ctx();
  const { data: lead } = await sb.from("leads").select("client_id").eq("id", leadId).single();

  const { error } = await sb
    .from("leads")
    .update({ deposit_amount: amount, deposit_requested_at: new Date().toISOString() })
    .eq("id", leadId);
  if (error) return { ok: false as const, error: error.message };

  const { data: open } = await sb
    .from("follow_ups")
    .select("id")
    .eq("lead_id", leadId)
    .eq("reason", "deposit")
    .eq("status", "open")
    .limit(1)
    .maybeSingle();
  if (!open) {
    await sb.from("follow_ups").insert({
      lead_id: leadId,
      client_id: lead?.client_id ?? null,
      reason: "deposit",
      due_at: tomorrowMorning(),
      assigned_to: userId,
      created_by: userId,
      metadata: { amount },
    });
  }
  await sb.from("activities").insert({
    lead_id: leadId,
    client_id: lead?.client_id ?? null,
    actor_id: userId,
    type: "note",
    summary: `Deposit requested — £${amount.toFixed(0)}`,
  });
  refresh(leadId);
  return { ok: true as const };
}

/** Mark deposit/balance paid: stamps the lead and closes any open matching chase.
 *  When the lead has an accepted quote in the Zoho flow, this routes through the
 *  full paid pipeline instead — Zoho payment record (BACS), customer confirmation
 *  email, lead Confirmed — so the one-tap does everything, not just the stamp. */
export async function markPaymentPaidAction(
  leadId: string,
  kind: "deposit" | "balance",
  method: "bank_transfer" | "cash" = "bank_transfer",
) {
  const { sb, userId } = await ctx();
  const { data: lead } = await sb.from("leads").select("client_id").eq("id", leadId).single();

  // Zoho-flow path: an accepted quote owns the payment lifecycle.
  const { data: acceptedQuote } = await sb
    .from("quotes")
    .select("id")
    .eq("lead_id", leadId)
    .eq("status", "accepted")
    .order("accepted_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (acceptedQuote) {
    const res =
      kind === "deposit"
        ? await markDepositPaid(sb, acceptedQuote.id, {
            method,
            actorId: userId,
            recordInZoho: true,
          })
        : await markBalancePaid(sb, acceptedQuote.id, userId, true, method);
    if (!res.ok) return { ok: false as const, error: res.error ?? "Could not mark paid" };
    // markDepositPaid stamps the quote+lead; mirror the lead stamp for the
    // manual-deposit case where only the quote knew the amount.
    refresh(leadId);
    return { ok: true as const };
  }

  const patch = kind === "deposit" ? { deposit_paid_at: new Date().toISOString() } : { balance_paid_at: new Date().toISOString() };
  const { error } = await sb.from("leads").update(patch).eq("id", leadId);
  if (error) return { ok: false as const, error: error.message };

  const { data: open } = await sb
    .from("follow_ups")
    .select("id")
    .eq("lead_id", leadId)
    .eq("reason", kind)
    .eq("status", "open");
  for (const fu of open ?? []) {
    await sb.from("follow_ups").update({ status: "done", outcome: "paid" }).eq("id", fu.id);
  }
  await sb.from("activities").insert({
    lead_id: leadId,
    client_id: lead?.client_id ?? null,
    actor_id: userId,
    type: "note",
    summary: kind === "deposit" ? "Deposit paid" : "Balance paid",
  });
  refresh(leadId);
  return { ok: true as const };
}

/** Set the balance (amount + due date) and open a balance chase due on that date. */
export async function setBalanceAction(leadId: string, amount: number, dueDate: string) {
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false as const, error: "Enter a balance amount" };
  // dueDate arrives as yyyy-mm-dd; the chase fires 09:00 UK on that day.
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dueDate);
  const due = dm ? ukInstant(Number(dm[1]), Number(dm[2]), Number(dm[3]), 9, 0) : new Date(NaN);
  if (Number.isNaN(due.getTime())) return { ok: false as const, error: "Pick a due date" };
  const { sb, userId } = await ctx();
  const { data: lead } = await sb.from("leads").select("client_id").eq("id", leadId).single();

  const { error } = await sb
    .from("leads")
    .update({ balance_amount: amount, balance_due_date: dueDate })
    .eq("id", leadId);
  if (error) return { ok: false as const, error: error.message };

  const { data: open } = await sb
    .from("follow_ups")
    .select("id")
    .eq("lead_id", leadId)
    .eq("reason", "balance")
    .eq("status", "open")
    .limit(1)
    .maybeSingle();
  if (!open) {
    await sb.from("follow_ups").insert({
      lead_id: leadId,
      client_id: lead?.client_id ?? null,
      reason: "balance",
      due_at: due.toISOString(),
      assigned_to: userId,
      created_by: userId,
      metadata: { amount },
    });
  } else {
    await sb.from("follow_ups").update({ due_at: due.toISOString(), metadata: { amount } }).eq("id", open.id);
  }
  await sb.from("activities").insert({
    lead_id: leadId,
    client_id: lead?.client_id ?? null,
    actor_id: userId,
    type: "note",
    summary: `Balance set — £${amount.toFixed(0)} due ${dueDate}`,
  });
  refresh(leadId);
  return { ok: true as const };
}
