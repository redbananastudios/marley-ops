"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOfficeProfile } from "@/lib/ai/auth";
import { sendOpsAlert } from "@/lib/comms/dispatch";
import { sendReviewRequest } from "@/lib/comms/review-request";
import { buildHeldSnapshot, createRefundQueueEntry } from "@/lib/refunds";
import { queueAmountsFor } from "@/lib/comms/cancellation-emails";
import { ukDayOf } from "@/lib/sales-report";
import { voidInvoice } from "@/lib/zoho";
import { attachOrCreateClient, findExistingClient } from "@/lib/leads/resolver";
import { isBackwardMove } from "@/lib/leads/funnel";
import { normalizePhone } from "@/lib/leads/phone";
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
      // 3rd-party referral fee for this lead — reports count it as a job cost.
      referral_commission:
        v.referral_commission === "" || v.referral_commission == null
          ? null
          : Number(v.referral_commission),
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
 * Create a lead and land the user on its detail page via a SERVER-SIDE redirect.
 *
 * The form used to `await createLeadAction()` then client-side `router.push()`.
 * That push races the server action's automatic revalidation of the page it was
 * called from, and on a higher-latency deploy the revalidation wins — bouncing
 * the user back to the empty /leads/new form (nothing shows, so they re-submit
 * and create a DUPLICATE lead). A server redirect is atomic: the navigation IS
 * the action's response, so there is no client push to lose the race. Returns
 * the {ok:false} validation error unchanged; on success it never returns (the
 * redirect throws NEXT_REDIRECT, which Next turns into the navigation).
 */
export async function createLeadAndOpenAction(input: NewLeadInput) {
  const res = await createLeadAction(input);
  if (!res.ok) return res;
  redirect(`/leads/${res.leadId}`);
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
      // Only write the commission when the client actually SENT the field — a
      // stale pre-deploy edit dialog (no such input) must not wipe a recorded
      // commission to null on an unrelated save.
      ...(v.referral_commission !== undefined
        ? { referral_commission: v.referral_commission === "" ? null : Number(v.referral_commission) }
        : {}),
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

export async function updateLeadStatusAction(
  leadId: string,
  status: string,
  opts?: { reason?: string },
) {
  const { sb, userId } = await actor();

  // Losses must go through markLeadLostAction — it records the WHY (the
  // "why we lose" report) and unwinds appointments/invoices. A raw status
  // write to declined would silently skip both.
  if (status === "declined") {
    return {
      ok: false as const,
      error: "Use Mark lost instead — it records the reason and unwinds bookings and invoices.",
    };
  }

  const { data: current } = await sb
    .from("leads")
    .select("status, client_id, first_contacted_at")
    .eq("id", leadId)
    .single();
  if (!current) return { ok: false as const, error: "Lead not found." };
  const from = current.status;

  // Moving a job BACKWARDS down the funnel (e.g. confirmed → quoted) is rare
  // and usually means something went wrong — require a reason so the timeline
  // says why, mirroring mark-lost. Reopening a declined lead isn't backward
  // (declined sits outside the funnel), so it stays a plain move.
  const reason = opts?.reason?.trim() || null;
  const backward = isBackwardMove(from, status);
  if (backward && !reason) {
    return {
      ok: false as const,
      needsReason: true as const,
      error: "Moving a job backwards needs a reason.",
    };
  }

  // First time anyone moves a lead off its initial state = first contact.
  // Powers the dashboard "median response time" metric.
  const stampContact = !current.first_contacted_at;

  // Reopening a lost lead: clear the loss record and PAUSE chasing — a
  // reopened lead is hand-managed (its old quote dates would instantly
  // re-trip the 30-day auto-lapse otherwise).
  const reopening = from === "declined" && status !== "declined";

  // Conditional on the status we just read (same pattern as the auto-lapse
  // cron): if another user moved the lead between our read and this write, the
  // backward check above ran against a stale "from" — 0 rows matched means
  // don't write, make the caller resync and retry against the fresh status.
  const { data: updated, error } = await sb
    .from("leads")
    .update({
      status: status as never,
      ...(stampContact ? { first_contacted_at: new Date().toISOString() } : {}),
      ...(reopening ? { lost_reason: null, lost_note: null, lost_at: null, chase_paused: true } : {}),
    } as never)
    .eq("id", leadId)
    .eq("status", from as never)
    .select("id");
  if (error) return { ok: false as const, error: error.message };
  if (!updated?.length) {
    return {
      ok: false as const,
      stale: true as const,
      error: "This lead just changed in another window — try again.",
    };
  }

  // A reopened lead's booking is live again: clear the cancellation marker so
  // /q + the chase ladder wake back up (it was stamped by the mark-lost /
  // Marley-cancel unwind).
  if (reopening) {
    await createAdminClient()
      .from("quotes")
      .update({ booking_cancelled_at: null } as never)
      .eq("lead_id", leadId)
      .eq("status", "accepted")
      .not("booking_cancelled_at", "is", null);
  }

  await sb.from("activities").insert({
    client_id: current?.client_id ?? null,
    lead_id: leadId,
    actor_id: userId,
    type: "status_change",
    summary: `Status: ${from ?? "—"} → ${status}${backward && reason ? ` — ${reason}` : ""}`,
    meta: { from, to: status, ...(backward && reason ? { reason } : {}) },
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
 * Office switch for the automatic post-move review-request email. Off = skip the
 * ask for a customer who wasn't fully satisfied; on = let it send after
 * completion. Office-gated; no-op once the ask has already been sent.
 */
export async function setReviewSuppressionAction(leadId: string, suppressed: boolean) {
  if (!z.string().uuid().safeParse(leadId).success) return { ok: false as const, error: "Invalid lead" };
  const office = await requireOfficeProfile();
  if (!office) return { ok: false as const, error: "Office access required." };
  const sb = await createClient();

  const { data: current } = await sb
    .from("leads")
    .select("client_id, review_requested_at, review_suppressed")
    .eq("id", leadId)
    .maybeSingle();
  if (!current) return { ok: false as const, error: "Lead not found." };
  if (current.review_requested_at) {
    return { ok: false as const, error: "The review request has already been sent for this job." };
  }
  if (current.review_suppressed === suppressed) {
    return { ok: true as const }; // already in the desired state — nothing to log
  }

  const { error } = await sb.from("leads").update({ review_suppressed: suppressed } as never).eq("id", leadId);
  if (error) return { ok: false as const, error: error.message };

  await sb.from("activities").insert({
    lead_id: leadId,
    client_id: current.client_id ?? null,
    actor_id: office.id,
    type: "note",
    summary: suppressed ? "Review request switched off — office decision" : "Review request re-enabled",
    meta: { review_suppressed: suppressed },
  });

  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/leads");
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
    .select("status, client_id, balance_paid_at, name, date_confirmed_at")
    .eq("id", leadId)
    .single();

  // Single-winner transition (mirrors updateLeadStatusAction's CAS): a concurrent
  // double-fire — two tabs, or a board-drag racing the mark-lost dialog — flips 0
  // rows and returns WITHOUT re-running the money unwind below (which would insert
  // duplicate refund tasks + money alerts and re-void an already-void invoice).
  const { data: flipped, error } = await sb
    .from("leads")
    .update({
      status: "declined",
      lost_reason: reason,
      lost_note: note?.trim() || null,
      lost_at: new Date().toISOString(),
      chase_paused: true,
    } as never)
    .eq("id", leadId)
    .neq("status", "declined")
    .select("id");
  if (error) return { ok: false as const, error: error.message };
  if (!flipped?.length) {
    // Already lost — the first caller ran the full unwind. Nothing more to do.
    revalidatePath(`/leads/${leadId}`);
    revalidatePath("/leads");
    return { ok: true as const };
  }

  const { data: open } = await sb
    .from("follow_ups")
    .select("id")
    .eq("lead_id", leadId)
    .eq("status", "open");
  for (const fu of open ?? []) {
    await sb.from("follow_ups").update({ status: "cancelled", outcome: "declined" }).eq("id", fu.id);
  }

  // Retire the quotes themselves — the same vocabulary the customer's online
  // decline uses. Without this a lost lead's sent quote lingered on /quotes
  // under "Awaiting reply" with a live follow-up nudge and an open-pipeline
  // value (Alex Randall MMR025, 2026-08-05). Only pre-acceptance quotes flip:
  // an ACCEPTED quote's cancellation is the booking_cancelled_at marker + the
  // money unwind below, and the reopen path depends on its status surviving.
  const { error: retireError } = await sb
    .from("quotes")
    .update({
      status: "rejected",
      declined_at: new Date().toISOString(),
      declined_reason: reason,
    } as never)
    .eq("lead_id", leadId)
    .in("status", ["draft", "sent"]);
  if (retireError) {
    await sendOpsAlert(`Quote retirement failed on mark-lost — lead ${leadId}`, [
      `The lead was marked lost but its open quote(s) could not be set to rejected (${retireError.message}) — they will still show as awaiting reply on /quotes.`,
    ], "system");
  }

  // --- unwind the booking, not just the status -------------------------------
  // A cancelled job must leave nothing live behind it: diary slots are freed,
  // unpaid Zoho invoices are voided (they stay on the books as void), and paid
  // money becomes an explicit refund decision for a human — never touched by code.
  let voidedInvoices = 0;
  let refundTask = false;
  let anyMoneyTaken = false;

  // Free upcoming diary slots (surveys and removals both). starts_at/appt_type
  // are captured so the refund-queue row can anchor to the cancelled removal.
  const { data: cancelledAppts } = await sb
    .from("appointments")
    .update({ status: "cancelled" as never })
    .eq("lead_id", leadId)
    .eq("status", "scheduled")
    .gte("starts_at", new Date().toISOString())
    .select("id, appt_type, starts_at");
  const apptsCancelled = cancelledAppts?.length ?? 0;

  // The money on the lead's accepted quote(s).
  const { data: moneyQuotes } = await sb
    .from("quotes")
    .select(
      "id, quote_ref, moving_date, deposit_amount, deposit_paid_at, zoho_deposit_invoice_id, zoho_deposit_invoice_number, zoho_balance_invoice_id, zoho_balance_invoice_number, balance_invoice_amount, commitment_paid_at, commitment_invoice_amount, zoho_commitment_invoice_id, zoho_commitment_invoice_number, estimator_id, client_id",
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
        ], "system");
      }
    }
    // Unpaid commitment invoice → void (Payments Policy v2 — the -COM invoice
    // sits between deposit and balance and must not survive a cancellation).
    if (!q.commitment_paid_at && isReal(q.zoho_commitment_invoice_id)) {
      try {
        await voidInvoice(q.zoho_commitment_invoice_id!);
        voidedInvoices++;
        await sb.from("activities").insert({
          lead_id: leadId,
          client_id: current?.client_id ?? null,
          actor_id: userId,
          type: "note",
          summary: `Commitment invoice ${q.zoho_commitment_invoice_number ?? ""} voided — booking cancelled`.trim(),
          meta: { quote_id: q.id, invoice_id: q.zoho_commitment_invoice_id },
        });
      } catch (err) {
        await sendOpsAlert(`Void on cancel FAILED — ${q.quote_ref}`, [
          `Lead cancelled but voiding commitment invoice ${q.zoho_commitment_invoice_number ?? ""} failed: ${err instanceof Error ? err.message : "unknown"}. Void it manually in Zoho.`,
        ], "system");
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
        ], "system");
      }
    }
    // Money already taken? (Recorded stamps; card money is caught below by the
    // held snapshot even if a stamp is missing.)
    const paidBits = [
      q.deposit_paid_at ? `£${Number(q.deposit_amount ?? 0).toFixed(2)} deposit` : null,
      q.commitment_paid_at ? `£${Number(q.commitment_invoice_amount ?? 0).toFixed(2)} commitment` : null,
      current?.balance_paid_at ? `£${Number(q.balance_invoice_amount ?? 0).toFixed(2)} balance` : null,
    ].filter(Boolean);
    if (paidBits.length) anyMoneyTaken = true;
  }

  // Money already taken → ONE refund-queue row per cancellation (Payments
  // Policy v2 — replaces the old "refund decision" follow-up task). The held
  // snapshot reads ground truth (card_payments net of refunds + the recorded
  // deposit/commitment/balance stamps — closes the old card-rail gap), and
  // createRefundQueueEntry fires the accounts@ money alert + writes the
  // timeline/audit pair. Service role: refund_queue has no insert policy by
  // design, and only an office session can win the CAS above to reach here.
  if (moneyQuotes?.length) {
    const admin = createAdminClient();

    // Retire the public money surface: the emailed /q link must stop
    // soliciting payment (bank details against now-voided invoices) and
    // confirmMoveDate must refuse — booking_cancelled_at is the marker every
    // money surface reads. Cleared again if the lead is reopened. Fail-soft.
    const { error: cancelMarkError } = await admin
      .from("quotes")
      .update({ booking_cancelled_at: new Date().toISOString() } as never)
      .eq("lead_id", leadId)
      .eq("status", "accepted")
      .is("booking_cancelled_at", null);
    if (cancelMarkError) {
      await sendOpsAlert(`Cancellation marker failed on mark-lost — ${moneyQuotes[0]?.quote_ref ?? leadId}`, [
        `booking_cancelled_at could not be stamped (${cancelMarkError.message}) — the /q page may still show payment panels for this cancelled booking.`,
      ], "system");
    }

    const snapshot = await buildHeldSnapshot(admin, leadId);
    if (snapshot.held.length) {
      // Pre-confirmation the deposit never became non-refundable: everything
      // is unconditional and the row goes straight to execution ("filled"
      // semantics — refund it all). Post-confirmation it's a conditional row:
      // the /refunds page asks "did the old day re-book?".
      const dateConfirmed = !!(current as { date_confirmed_at?: string | null } | null)?.date_confirmed_at;
      const amounts = queueAmountsFor(snapshot.split, dateConfirmed);
      const cancelledRemoval = (cancelledAppts ?? [])
        .filter((a) => a.appt_type === "removal")
        .sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)))[0];
      const moneyQuote = moneyQuotes.find((q) => q.id === snapshot.quote?.id) ?? moneyQuotes[0];
      const res = await createRefundQueueEntry(admin, {
        leadId,
        quoteId: snapshot.quote?.id ?? moneyQuote?.id ?? null,
        trigger: "customer_cancel",
        held: snapshot.held,
        conditionalAmount: amounts.conditional,
        unconditionalAmount: amounts.unconditional,
        originalMoveDate: moneyQuote?.moving_date ?? ukDayOf(cancelledRemoval?.starts_at ?? null),
        oldAppointmentId: cancelledRemoval?.id ?? null,
        determination: dateConfirmed ? null : "filled",
        actorId: userId,
        clientId: moneyQuote?.client_id ?? current?.client_id ?? null,
        customerName: current?.name ?? null,
        quoteRef: snapshot.quote?.quote_ref ?? moneyQuote?.quote_ref ?? null,
        notes: dateConfirmed
          ? null
          : "Cancelled before the move date was confirmed — everything refunds in full.",
      });
      refundTask = res.ok;
    } else if (anyMoneyTaken) {
      // Paid stamps say money was taken but the snapshot resolved nothing
      // held. Two legitimate reasons: a card payment sitting in needs_review,
      // OR the money was ALREADY refunded/settled through an earlier queue row
      // (the snapshot nets executed payouts out). Only the first needs a
      // human — an alert on the second would send accounts chasing money that
      // was correctly returned.
      const { data: settled } = await admin
        .from("refund_queue")
        .select("id")
        .eq("lead_id", leadId)
        .in("status", ["refunded", "retained", "released"])
        .limit(1)
        .maybeSingle();
      if (!settled) {
        await sendOpsAlert(`Cancellation with money taken but nothing snapshotted — ${moneyQuotes[0]?.quote_ref ?? leadId}`, [
          `<strong>${current?.name ?? "Customer"}</strong> cancelled with recorded payments, but the held-money snapshot resolved £0 — likely a card payment awaiting review.`,
          `No refund-queue row was created. Reconcile the payments and raise the refund decision manually.`,
        ], "money");
      }
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
