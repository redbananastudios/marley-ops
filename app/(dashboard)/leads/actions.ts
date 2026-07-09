"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { sendOpsAlert } from "@/lib/comms/dispatch";
import { sendReviewRequest } from "@/lib/comms/review-request";
import { voidInvoice } from "@/lib/zoho";
import { attachOrCreateClient, findExistingClient } from "@/lib/leads/resolver";
import { normalizeEmail, normalizePhone } from "@/lib/leads/phone";
import {
  editLeadSchema,
  newLeadSchema,
  type EditLeadInput,
  type NewLeadInput,
} from "@/lib/leads/schema";

async function actor() {
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  return { sb, userId: user?.id ?? null };
}

/** Live dedupe check for the Add-lead form. Read-only. */
export async function checkDuplicateAction(input: { phone?: string; email?: string }) {
  const { sb } = await actor();
  const match = await findExistingClient(sb, input);
  if (!match) return { matched: false as const };
  return {
    matched: true as const,
    clientName: match.client.display_name,
    matchedOn: match.matchedOn,
    previousLeadCount: match.previousLeadCount,
  };
}

export async function createLeadAction(input: NewLeadInput) {
  const parsed = newLeadSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const v = parsed.data;
  const { sb, userId } = await actor();

  // An explicit customer pick attaches straight to that client; otherwise dedupe on
  // contact details (attach to a match, or create a new client).
  let clientId: string;
  let matched: boolean;
  let previousLeadCount: number;
  if (v.client_id) {
    clientId = v.client_id;
    matched = true;
    const { count } = await sb
      .from("leads")
      .select("id", { count: "exact", head: true })
      .eq("client_id", v.client_id);
    previousLeadCount = count ?? 0;
  } else {
    ({ clientId, matched, previousLeadCount } = await attachOrCreateClient(sb, {
      name: v.name,
      phone: v.phone,
      email: v.email,
      postcode: v.from_postcode,
    }));
  }

  const { data: lead, error } = await sb
    .from("leads")
    .insert({
      client_id: clientId,
      // No estimator at the lead stage — the estimator is assigned when a survey is
      // booked (it lives on the survey/appointment). Leaving this null keeps the
      // lead's "estimator" honest: empty until there's actually a survey to do.
      status: "website_enquiry",
      entry_channel: v.entry_channel,
      referrer_answer: v.referrer_answer || null,
      source_system: "marley_ops",
      name: v.name,
      phone: v.phone || null,
      email: v.email || null,
      from_postcode: v.from_postcode || null,
      to_postcode: v.to_postcode || null,
      from_address: v.from_address || null,
      to_address: v.to_address || null,
      property_size: v.property_size || null,
      preferred_date: v.preferred_date || null,
      notes: v.notes || null,
    })
    .select("id")
    .single();

  if (error) return { ok: false as const, error: error.message };

  await sb.from("activities").insert({
    client_id: clientId,
    lead_id: lead.id,
    actor_id: userId,
    type: "lead_created",
    summary: `Lead created (${v.entry_channel.replace(/_/g, " ")})`,
    meta: { matched_existing_client: matched, previous_lead_count: previousLeadCount },
  });

  revalidatePath("/leads");
  revalidatePath("/");
  return { ok: true as const, leadId: lead.id, matchedExistingClient: matched };
}

/**
 * Mark a lead contacted without changing its status — stamps first_contacted_at
 * (the field the dashboard's median-response metric reads) and logs it. Idempotent:
 * a no-op once already stamped.
 */
export async function markLeadContactedAction(leadId: string) {
  const { sb, userId } = await actor();
  const { data: cur } = await sb
    .from("leads")
    .select("first_contacted_at, client_id")
    .eq("id", leadId)
    .single();
  if (cur?.first_contacted_at) return { ok: true as const, already: true as const };

  const { error } = await sb
    .from("leads")
    .update({ first_contacted_at: new Date().toISOString() })
    .eq("id", leadId);
  if (error) return { ok: false as const, error: error.message };

  await sb.from("activities").insert({
    client_id: cur?.client_id ?? null,
    lead_id: leadId,
    actor_id: userId,
    type: "note",
    summary: "Marked contacted",
  });

  revalidatePath("/leads");
  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/");
  return { ok: true as const };
}

/**
 * Reverse a mistaken "mark contacted" — clears first_contacted_at so the lead drops
 * back into the uncontacted queue and stops counting toward the response-time metric.
 * Idempotent: a no-op if it was never contacted. Status is left untouched.
 */
export async function markLeadUncontactedAction(leadId: string) {
  const { sb, userId } = await actor();
  const { data: cur } = await sb
    .from("leads")
    .select("first_contacted_at, client_id")
    .eq("id", leadId)
    .single();
  if (!cur?.first_contacted_at) return { ok: true as const, already: true as const };

  const { error } = await sb
    .from("leads")
    .update({ first_contacted_at: null })
    .eq("id", leadId);
  if (error) return { ok: false as const, error: error.message };

  await sb.from("activities").insert({
    client_id: cur?.client_id ?? null,
    lead_id: leadId,
    actor_id: userId,
    type: "note",
    summary: "Reverted to uncontacted",
  });

  revalidatePath("/leads");
  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/");
  return { ok: true as const };
}

/**
 * Edit a lead's customer + move details. Writes the lead row AND keeps the linked
 * client's core contact in step (the detail page reads client-first), so a correction
 * shows everywhere. A phone/email change that collides with another live client is
 * surfaced as a friendly error rather than a raw unique-violation.
 */
export async function updateLeadDetailsAction(leadId: string, input: EditLeadInput) {
  const parsed = editLeadSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const v = parsed.data;
  const { sb, userId } = await actor();

  const { data: lead } = await sb.from("leads").select("client_id").eq("id", leadId).single();

  const estimate =
    v.estimate_given === "" || v.estimate_given == null ? null : Number(v.estimate_given);

  const { error } = await sb
    .from("leads")
    .update({
      name: v.name,
      phone: v.phone || null,
      email: v.email || null,
      from_postcode: v.from_postcode || null,
      to_postcode: v.to_postcode || null,
      from_address: v.from_address || null,
      to_address: v.to_address || null,
      property_size: v.property_size || null,
      preferred_date: v.preferred_date || null,
      estimate_given: estimate,
      notes: v.notes || null,
    })
    .eq("id", leadId);
  if (error) return { ok: false as const, error: error.message };

  // Keep the linked client's core contact aligned with the correction.
  if (lead?.client_id) {
    const { error: cErr } = await sb
      .from("clients")
      .update({
        display_name: v.name,
        phone_raw: v.phone || null,
        phone_e164: normalizePhone(v.phone),
        email: v.email || null,
        postcode_home: v.from_postcode || null,
      })
      .eq("id", lead.client_id);
    if (cErr) {
      const dupe = /duplicate|unique/i.test(cErr.message);
      return {
        ok: false as const,
        error: dupe
          ? "That phone or email already belongs to another client."
          : cErr.message,
      };
    }
  }

  await sb.from("activities").insert({
    client_id: lead?.client_id ?? null,
    lead_id: leadId,
    actor_id: userId,
    type: "note",
    summary: "Lead details edited",
  });

  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/leads");
  return { ok: true as const };
}

/** Assign (or clear) the estimator who owns this lead. */
export async function assignLeadOwnerAction(leadId: string, estimatorId: string | null) {
  const { sb, userId } = await actor();
  const { data: lead } = await sb.from("leads").select("client_id").eq("id", leadId).single();

  const { error } = await sb
    .from("leads")
    .update({ estimator_id: estimatorId })
    .eq("id", leadId);
  if (error) return { ok: false as const, error: error.message };

  let who = "Unassigned";
  if (estimatorId) {
    const { data: p } = await sb.from("profiles").select("full_name").eq("id", estimatorId).single();
    who = p?.full_name || "an estimator";
  }
  await sb.from("activities").insert({
    client_id: lead?.client_id ?? null,
    lead_id: leadId,
    actor_id: userId,
    type: "note",
    summary: `Estimator set to ${who}`,
  });

  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/leads");
  return { ok: true as const };
}

export async function updateLeadStatusAction(leadId: string, status: string) {
  const { sb, userId } = await actor();
  const { data: current } = await sb
    .from("leads")
    .select("status, client_id, first_contacted_at")
    .eq("id", leadId)
    .single();
  const from = current?.status ?? null;

  // First time anyone moves a lead off its initial state = first contact.
  // Powers the dashboard "median response time" metric.
  const stampContact = !current?.first_contacted_at;

  // Reopening a lost lead: clear the loss record and PAUSE chasing — a
  // reopened lead is hand-managed (its old quote dates would instantly
  // re-trip the 30-day auto-lapse otherwise).
  const reopening = from === "declined" && status !== "declined";

  const { error } = await sb
    .from("leads")
    .update({
      status: status as never,
      ...(stampContact ? { first_contacted_at: new Date().toISOString() } : {}),
      ...(reopening ? { lost_reason: null, lost_note: null, lost_at: null, chase_paused: true } : {}),
    } as never)
    .eq("id", leadId);
  if (error) return { ok: false as const, error: error.message };

  await sb.from("activities").insert({
    client_id: current?.client_id ?? null,
    lead_id: leadId,
    actor_id: userId,
    type: "status_change",
    summary: `Status: ${from ?? "—"} → ${status}`,
    meta: { from, to: status },
  });

  // Move done → ask for the Google review (once per lead, settings-gated;
  // fail-soft so a comms hiccup never blocks the status change).
  if (status === "completed") {
    await sendReviewRequest(sb, leadId, userId).catch(() => null);
  }

  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/leads");
  revalidatePath("/");
  return { ok: true as const };
}

/**
 * Mark a lead lost with a structured reason (+ optional note) — feeds the
 * Performance "why we lose quotes" breakdown. Never deletes: lost leads stay
 * in the data for dedupe + analysis. Also stops the chase engine and cancels
 * any open follow-ups.
 */
export async function markLeadLostAction(leadId: string, reason: string, note?: string) {
  const VALID = ["too_expensive", "chose_competitor", "move_fell_through", "dates_didnt_work", "no_response", "other"];
  if (!VALID.includes(reason)) return { ok: false as const, error: "Pick a reason" };
  const { sb, userId } = await actor();
  const { data: current } = await sb
    .from("leads")
    .select("status, client_id, balance_paid_at, name")
    .eq("id", leadId)
    .single();

  const { error } = await sb
    .from("leads")
    .update({
      status: "declined",
      lost_reason: reason,
      lost_note: note?.trim() || null,
      lost_at: new Date().toISOString(),
      chase_paused: true,
    } as never)
    .eq("id", leadId);
  if (error) return { ok: false as const, error: error.message };

  const { data: open } = await sb
    .from("follow_ups")
    .select("id")
    .eq("lead_id", leadId)
    .eq("status", "open");
  for (const fu of open ?? []) {
    await sb.from("follow_ups").update({ status: "cancelled", outcome: "declined" }).eq("id", fu.id);
  }

  // --- unwind the booking, not just the status -------------------------------
  // A cancelled job must leave nothing live behind it: diary slots are freed,
  // unpaid Zoho invoices are voided (they stay on the books as void), and paid
  // money becomes an explicit refund decision for a human — never touched by code.
  let voidedInvoices = 0;
  let refundTask = false;

  // Free upcoming diary slots (surveys and removals both).
  const { data: cancelledAppts } = await sb
    .from("appointments")
    .update({ status: "cancelled" as never })
    .eq("lead_id", leadId)
    .eq("status", "scheduled")
    .gte("starts_at", new Date().toISOString())
    .select("id");
  const apptsCancelled = cancelledAppts?.length ?? 0;

  // The money on the lead's accepted quote(s).
  const { data: moneyQuotes } = await sb
    .from("quotes")
    .select(
      "id, quote_ref, deposit_amount, deposit_paid_at, zoho_deposit_invoice_id, zoho_deposit_invoice_number, zoho_balance_invoice_id, zoho_balance_invoice_number, balance_invoice_amount, estimator_id, client_id",
    )
    .eq("lead_id", leadId)
    .eq("status", "accepted");

  const isReal = (v: string | null) => !!v && v !== "pending";
  for (const q of moneyQuotes ?? []) {
    // Unpaid deposit invoice → void.
    if (!q.deposit_paid_at && isReal(q.zoho_deposit_invoice_id)) {
      try {
        await voidInvoice(q.zoho_deposit_invoice_id!);
        voidedInvoices++;
        await sb.from("activities").insert({
          lead_id: leadId,
          client_id: current?.client_id ?? null,
          actor_id: userId,
          type: "note",
          summary: `Deposit invoice ${q.zoho_deposit_invoice_number ?? ""} voided — booking cancelled`.trim(),
          meta: { quote_id: q.id, invoice_id: q.zoho_deposit_invoice_id },
        });
      } catch (err) {
        await sendOpsAlert(`Void on cancel FAILED — ${q.quote_ref}`, [
          `Lead cancelled but voiding deposit invoice ${q.zoho_deposit_invoice_number ?? ""} failed: ${err instanceof Error ? err.message : "unknown"}. Void it manually in Zoho.`,
        ]);
      }
    }
    // Unpaid balance invoice → void.
    if (!current?.balance_paid_at && isReal(q.zoho_balance_invoice_id)) {
      try {
        await voidInvoice(q.zoho_balance_invoice_id!);
        voidedInvoices++;
        await sb.from("activities").insert({
          lead_id: leadId,
          client_id: current?.client_id ?? null,
          actor_id: userId,
          type: "note",
          summary: `Balance invoice ${q.zoho_balance_invoice_number ?? ""} voided — booking cancelled`.trim(),
          meta: { quote_id: q.id, invoice_id: q.zoho_balance_invoice_id },
        });
      } catch (err) {
        await sendOpsAlert(`Void on cancel FAILED — ${q.quote_ref}`, [
          `Lead cancelled but voiding balance invoice ${q.zoho_balance_invoice_number ?? ""} failed: ${err instanceof Error ? err.message : "unknown"}. Void it manually in Zoho.`,
        ]);
      }
    }
    // Money already taken → a human decides the refund (deposit terms may keep it).
    const paidBits = [
      q.deposit_paid_at ? `£${Number(q.deposit_amount ?? 0).toFixed(2)} deposit` : null,
      current?.balance_paid_at ? `£${Number(q.balance_invoice_amount ?? 0).toFixed(2)} balance` : null,
    ].filter(Boolean);
    if (paidBits.length) {
      refundTask = true;
      await sb.from("follow_ups").insert({
        lead_id: leadId,
        client_id: q.client_id ?? current?.client_id ?? null,
        quote_id: q.id,
        reason: "custom",
        due_at: new Date().toISOString(),
        assigned_to: q.estimator_id ?? userId,
        created_by: userId,
        source: "cancellation",
        notes: `Booking cancelled with ${paidBits.join(" + ")} already paid (${q.quote_ref}). Decide refund vs retained deposit per the terms, and record the outcome in Zoho.`,
      } as never);
      await sendOpsAlert(`Cancellation with money taken — ${q.quote_ref}`, [
        `<strong>${current?.name ?? "Customer"}</strong> cancelled with ${paidBits.join(" + ")} already paid.`,
        `A refund-decision task is in Follow-ups. Nothing was changed in Zoho for the paid amounts.`,
      ]);
    }
  }

  const label = reason.replace(/_/g, " ");
  await sb.from("activities").insert({
    client_id: current?.client_id ?? null,
    lead_id: leadId,
    actor_id: userId,
    type: "status_change",
    summary: `Marked lost — ${label}${note?.trim() ? ` ("${note.trim()}")` : ""}${apptsCancelled ? ` · ${apptsCancelled} appointment${apptsCancelled === 1 ? "" : "s"} cancelled` : ""}${voidedInvoices ? ` · ${voidedInvoices} invoice${voidedInvoices === 1 ? "" : "s"} voided` : ""}`,
    meta: { from: current?.status ?? null, to: "declined", lost_reason: reason },
  });

  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/leads");
  revalidatePath("/bookings");
  revalidatePath("/follow-ups");
  revalidatePath("/");
  return { ok: true as const, apptsCancelled, voidedInvoices, refundTask };
}
