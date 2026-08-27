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
import { voidInvoice } from "@/lib/ledger";
import { attachOrCreateClient, findExistingClient } from "@/lib/leads/resolver";
import { isBackwardMove } from "@/lib/leads/funnel";
import { canDeleteLead, storageLetsBlockingDelete } from "@/lib/leads/deletable";
import { clientWriteThrough } from "@/lib/leads/shared-client";
import { normalizePhone } from "@/lib/leads/phone";
import {
  editLeadSchema,
  newLeadSchema,
  type EditLeadInput,
  type NewLeadInput,
} from "@/lib/leads/schema";
import { cleanApproxWindow, normaliseApproxMonth } from "@/lib/bookings/booking-details";
import { DEFAULT_BRAND, listActiveBrands } from "@/lib/brand";

async function actor() {
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  return { sb, userId: user?.id ?? null };
}

/**
 * Write a lead's provisional window (Beginning/Middle/End of a target month)
 * to booking_details — the side-table the Move Window drawer and /schedule's
 * "Thinking about it" panel already read. Partial upsert: provisional_date and
 * property_type are deliberately NOT in the payload so drawer-entered values
 * survive a lead-form save. Fail-soft (returns rather than throws) — the lead
 * write has already succeeded and must not be reported as failed.
 */
async function upsertLeadWindow(
  sb: Awaited<ReturnType<typeof createClient>>,
  leadId: string,
  approxMonth: string | null | undefined,
  approxWindow: string | null | undefined,
): Promise<{ ok: boolean }> {
  const month = normaliseApproxMonth(approxMonth ?? null);
  const tier = cleanApproxWindow(approxWindow ?? null);
  if (!month.ok) return { ok: false };
  // Nothing to record and nothing to clear → don't create an empty row.
  const { data: existing } = await sb
    .from("booking_details")
    .select("lead_id")
    .eq("lead_id", leadId)
    .maybeSingle();
  if (!existing && month.value == null && tier == null) return { ok: true };
  const { error } = await sb
    .from("booking_details")
    .upsert(
      { lead_id: leadId, approx_month: month.value, approx_window: tier },
      { onConflict: "lead_id" },
    );
  return { ok: !error };
}

/** Update ONLY a lead's enquiry notes — the diary dialogs' inline editor.
 *  Deliberately touches nothing else: the full edit form owns the rest, and a
 *  notes-only save must never wipe fields the caller never loaded. */
export async function updateLeadNotesAction(leadId: string, notes: string) {
  if (!z.string().uuid().safeParse(leadId).success) return { ok: false as const, error: "Invalid lead" };
  const { sb } = await actor();
  const { error } = await sb
    .from("leads")
    .update({ notes: notes.trim() || null })
    .eq("id", leadId);
  if (error) return { ok: false as const, error: error.message };
  revalidatePath("/leads");
  revalidatePath("/schedule");
  revalidatePath("/schedule/removals");
  revalidatePath("/schedule/surveys");
  return { ok: true as const };
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

  // GATE 5 — the lead's brand, resolved SERVER-SIDE and never trusted from
  // the client. Single-brand mode: the picker never rendered, so whatever
  // arrived is ignored and DEFAULT_BRAND is written. Multi-brand mode: the
  // value must name an ACTIVE brand slug — required with NO default, because
  // both phone lines ring the same office so nothing can be inferred.
  // Validated against listActiveBrands (data, not a constant list), so a
  // third brand needs no code change here.
  const activeBrands = await listActiveBrands(sb);
  let brand: string = DEFAULT_BRAND;
  if (activeBrands.length > 1) {
    const picked = v.brand && activeBrands.some((b) => b.slug === v.brand) ? v.brand : null;
    if (!picked) return { ok: false as const, error: "Choose which brand this enquiry is for." };
    brand = picked;
  }

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
      // Source of truth for the record's brand (PRD §3.2) — resolved above,
      // never the raw client value.
      brand,
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
      to_property_size: v.to_property_size || null,
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

  // Provisional window (Beginning/Middle/End of month) lives on booking_details,
  // never on the lead — the same side-table the Move Window drawer and the
  // /schedule "Thinking about it" panel read. Fail-soft: a window write must
  // not lose the lead that was just created.
  await upsertLeadWindow(sb, lead.id, v.approx_month, v.approx_window);

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
 * GATE 5 — change which brand a lead belongs to, PRE-QUOTE ONLY (the lead
 * page's eyebrow chip control, PRD §4 /leads/[id]).
 *
 * Once ANY quote reference exists for the lead the brand is fixed — the ref
 * prefix is minted from it, and a ref the customer has seen cannot change
 * meaning. Refs are minted at DRAFT creation (nextQuoteRef in
 * createDraftQuote), so in practice "a ref exists" means "any quotes row at
 * all"; the not-null filter keeps the check honest against any legacy
 * ref-less row. The client hides the control in that state, but the check
 * here is the one that counts.
 */
export async function updateLeadBrandAction(leadId: string, brandSlug: string) {
  if (!z.string().uuid().safeParse(leadId).success) return { ok: false as const, error: "Invalid lead" };
  const { sb, userId } = await actor();

  // Only meaningful in multi-brand mode, and only to an ACTIVE brand slug —
  // the control never renders otherwise, so anything else is a stale tab or a
  // forged call. Reject rather than guess.
  const activeBrands = await listActiveBrands(sb);
  if (activeBrands.length < 2) {
    return { ok: false as const, error: "Brand changes need more than one active brand." };
  }
  const target = activeBrands.find((b) => b.slug === brandSlug);
  if (!target) return { ok: false as const, error: "Pick an active brand." };

  const { data: lead } = await sb.from("leads").select("id, client_id, brand").eq("id", leadId).single();
  if (!lead) return { ok: false as const, error: "Lead not found" };
  if (lead.brand === target.slug) return { ok: true as const };

  // Server-side re-check of the client-side gate. A failed COUNT is a refusal
  // too — "could not check" must never act like "no refs" (the evidence bar).
  const { count: refCount, error: refError } = await sb
    .from("quotes")
    .select("id", { count: "exact", head: true })
    .eq("lead_id", leadId)
    .not("quote_ref", "is", null);
  if (refError) {
    return { ok: false as const, error: `Could not verify this lead's quotes: ${refError.message}` };
  }
  if ((refCount ?? 0) > 0) {
    return {
      ok: false as const,
      error:
        "A quote reference has already been issued for this lead — its brand (and the ref prefix) is fixed.",
    };
  }

  const { error } = await sb.from("leads").update({ brand: target.slug }).eq("id", leadId);
  if (error) return { ok: false as const, error: error.message };

  // Keep the denormalised copies in step (PRD §3.2: quotes.brand and
  // appointments.brand are set from the parent lead at insert). Pre-quote a
  // lead can still carry appointments — a booked survey colours the diary
  // from appointments.brand — plus belt-and-braces any ref-less quote row.
  // Fail-soft: the lead write is the source of truth and has already landed.
  await sb.from("appointments").update({ brand: target.slug }).eq("lead_id", leadId);
  await sb.from("quotes").update({ brand: target.slug }).eq("lead_id", leadId).is("quote_ref", null);

  // Audit — the SAME mechanism as every other edit on the lead page (the
  // activities timeline). The PRD names events_log, but this codebase's real
  // lead-edit audit surface is `activities` — the code wins (PRD §10);
  // events_log stays the money/webhook audit rail.
  await sb.from("activities").insert({
    client_id: lead.client_id ?? null,
    lead_id: leadId,
    actor_id: userId,
    type: "note",
    summary: `Brand changed to ${target.name}`,
    meta: { brand_from: lead.brand ?? null, brand_to: target.slug },
  });

  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/leads");
  revalidatePath("/");
  return { ok: true as const };
}

/**
 * Mark a lead contacted without changing its status — stamps first_contacted_at
 * (the field the dashboard's median-response metric reads) and logs it. Idempotent:
 * a no-op once already stamped.
 */
/**
 * Legacy iMVE bookings only: record that the customer has been informed by
 * phone (Luke's T-8/9 call) and lift the automated-email exclusion for this
 * booking — or restore it. The state lives on the quote (standard_comms_at)
 * because every exclusion site already holds the quote row (see lib/legacy.ts).
 */
export async function setStandardCommsAction(quoteId: string, enable: boolean) {
  const { sb, userId } = await actor();
  const { data: quote } = await sb
    .from("quotes")
    .select("id, quote_ref, lead_id, client_id, source, standard_comms_at")
    .eq("id", quoteId)
    .single();
  if (!quote) return { ok: false as const, error: "Quote not found" };
  if (quote.source !== "imve") {
    return { ok: false as const, error: "Only legacy (iMVE) bookings carry the standard-comms switch." };
  }
  if (enable === !!quote.standard_comms_at) return { ok: true as const };

  const { error } = await sb
    .from("quotes")
    .update({ standard_comms_at: enable ? new Date().toISOString() : null } as never)
    .eq("id", quoteId);
  if (error) return { ok: false as const, error: error.message };

  await sb.from("activities").insert({
    client_id: quote.client_id,
    lead_id: quote.lead_id,
    actor_id: userId,
    type: "note",
    summary: enable
      ? `Standard comms enabled (${quote.quote_ref}) — customer informed by phone; automated emails now apply to this booking.`
      : `Standard comms disabled (${quote.quote_ref}) — booking returned to legacy hands-off handling.`,
  });

  if (quote.lead_id) revalidatePath(`/leads/${quote.lead_id}`);
  revalidatePath("/leads");
  return { ok: true as const };
}

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
 * Edit a lead's customer + move details. Writes the lead row, and keeps the linked
 * client's core contact in step ONLY when this lead is the sole enquiry on that
 * client — see the write-through block below for why. A phone/email change that
 * collides with another live client is surfaced as a friendly error rather than a
 * raw unique-violation.
 */
export async function updateLeadDetailsAction(leadId: string, input: EditLeadInput) {
  const parsed = editLeadSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const v = parsed.data;
  const { sb, userId } = await actor();

  const { data: lead } = await sb
    .from("leads")
    .select("client_id, email, email_invalid_at")
    .eq("id", leadId)
    .single();

  const estimate =
    v.estimate_given === "" || v.estimate_given == null ? null : Number(v.estimate_given);

  // A bounce marks the lead email_invalid_at + chase_paused and opens a "this
  // address doesn't work" task. Nothing ever undid any of it — so correcting the
  // address left the customer permanently un-chaseable AND the task on the board
  // forever (Peter, 2026-08-10). Fixing the address IS the resolution.
  const newEmail = v.email || null;
  const emailChanged = (lead?.email ?? null) !== newEmail && !!newEmail;
  const clearingBounce = emailChanged && !!lead?.email_invalid_at;

  const { error } = await sb
    .from("leads")
    .update({
      name: v.name,
      phone: v.phone || null,
      email: newEmail,
      ...(clearingBounce ? { email_invalid_at: null, chase_paused: false } : {}),
      from_postcode: v.from_postcode || null,
      to_postcode: v.to_postcode || null,
      from_address: v.from_address || null,
      to_address: v.to_address || null,
      property_size: v.property_size || null,
      // Same stale-dialog guard as referral_commission: only write fields the
      // client actually sent, so a pre-deploy tab can't wipe them.
      ...(v.to_property_size !== undefined ? { to_property_size: v.to_property_size || null } : {}),
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

  // Provisional window → booking_details (partial upsert; drawer-owned fields
  // survive). Only when the dialog sent the fields, same stale-tab rule.
  if (v.approx_month !== undefined || v.approx_window !== undefined) {
    await upsertLeadWindow(sb, leadId, v.approx_month, v.approx_window);
    revalidatePath("/schedule");
    revalidatePath("/bookings");
  }

  // Keep the linked client's core contact aligned with the correction — but ONLY
  // when this lead is the sole enquiry on that client.
  //
  // Dedup attaches several enquiries to one client, and this write used to run
  // unconditionally: editing lead A rewrote the shared record, which every
  // sibling lead's page then displayed as its OWN contact details. Two customers
  // could not be told apart on their own pages (QA-20260819-01).
  //
  // Skipping the write is not harmless, so it is not silent. `clients.email` is a
  // real sending surface — storage invoices are addressed from it
  // (lib/storage/raise-storage-invoices.ts) — so a correction that stops here has
  // to be reported, or the office believes an address was fixed everywhere when it
  // was fixed in one place.
  let otherLeadCount: number | null = null;
  if (lead?.client_id) {
    const { count, error: sErr } = await sb
      .from("leads")
      .select("id", { count: "exact", head: true })
      .eq("client_id", lead.client_id)
      .neq("id", leadId);
    // A failed count stays null — `clientWriteThrough` reads that as "could not
    // check", which declines the write AND says so. Coercing it to 0 here would
    // turn a failed read into a licence to rewrite the shared record.
    otherLeadCount = sErr ? null : (count ?? 0);
  }
  const shared = clientWriteThrough({ clientId: lead?.client_id, otherLeadCount });
  if (shared.write && lead?.client_id) {
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

  if (clearingBounce) {
    await sb
      .from("follow_ups")
      .update({ status: "cancelled", outcome: "reached" })
      .eq("lead_id", leadId)
      .eq("reason", "custom")
      .eq("source", "email_bounced")
      .eq("status", "open");
    await sb.from("activities").insert({
      client_id: lead?.client_id ?? null,
      lead_id: leadId,
      actor_id: userId,
      type: "note",
      summary: "Email address corrected — bounce cleared and follow-ups resumed",
      meta: { previous_email: lead?.email ?? null, auto: true },
    });
    revalidatePath("/follow-ups");
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
  // `warning` is a SUCCESSFUL save that did less than the office would assume —
  // the lead is written, the shared customer record deliberately is not.
  return { ok: true as const, warning: shared.warning };
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
    const admin = createAdminClient();
    // The unwind VOIDED the Zoho invoices but left their ids on the quote, and
    // every raiser early-returns when it sees a real id (ensureDepositInvoice,
    // ensureCommitmentInvoice, createBalanceInvoiceFlow). Clearing only
    // booking_cancelled_at therefore revived a booking that could never be
    // invoiced again from the panel: the customer's /q page links a voided
    // document and the final balance is simply never billed. Drop the dead
    // references so the raisers mint fresh invoices at the current price.
    const { error: reviveError } = await admin
      .from("quotes")
      .update({
        booking_cancelled_at: null,
        zoho_deposit_invoice_id: null,
        zoho_deposit_invoice_number: null,
        zoho_deposit_invoice_url: null,
        zoho_commitment_invoice_id: null,
        zoho_commitment_invoice_number: null,
        zoho_commitment_invoice_url: null,
        commitment_invoice_amount: null,
        commitment_invoice_created_at: null,
        zoho_balance_invoice_id: null,
        zoho_balance_invoice_number: null,
        zoho_balance_invoice_url: null,
        balance_invoice_amount: null,
        balance_invoice_created_at: null,
      } as never)
      .eq("lead_id", leadId)
      .eq("status", "accepted")
      .not("booking_cancelled_at", "is", null);
    if (reviveError) {
      await sendOpsAlert(`Reopened booking may still hold voided invoices — lead ${leadId}`, [
        `The lead was reopened but clearing its voided Zoho invoice references failed: ${reviveError.message}.`,
        `Until that is fixed the panel will refuse to raise new deposit/commitment/balance invoices for this job.`,
      ], "money").catch(() => {});
    }

    // The cancel queued a refund. Reopening means the money stays with us and
    // funds the live booking again — the same shape as a date-change rebook,
    // which closes its row as 'released'. Without this /refunds keeps offering a
    // live "refund £X" button (pre-confirmation rows are immediately executable)
    // on a booking that is running again, and the dashboard counts it forever.
    const { error: refundError } = await admin
      .from("refund_queue")
      .update({ status: "released" } as never)
      .eq("lead_id", leadId)
      .eq("status", "pending");
    if (refundError) {
      await sendOpsAlert(`Reopened booking still has a pending refund — lead ${leadId}`, [
        `The lead was reopened but its pending refund_queue row could not be superseded: ${refundError.message}.`,
        `Check /refunds before anyone pays out against a live booking.`,
      ], "money").catch(() => {});
    }
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

/**
 * Delete a lead outright. This exists for DUPLICATES — the same customer
 * enquiring twice, the second carrying a typo — so the office can tidy the
 * pipeline without asking an engineer to run SQL (Peter, 2026-08-20).
 *
 * Deliberately narrow. `canDeleteLead` refuses anything carrying business
 * history (a quote, money, a diary slot, a signature), because deleting those
 * destroys the trail behind an invoice or a contract. Admin-only: this is the
 * one lead action with no undo.
 *
 * The lead's own history (activities, comms, follow-ups) is re-pointed at the
 * surviving sibling on the same client when there is exactly one, so a merge
 * keeps the conversation instead of dropping it. With no sibling, those rows
 * go with the lead — there is nowhere to keep them and nothing referring to
 * them.
 */
export async function deleteLeadAction(
  leadId: string,
): Promise<{ ok: true; mergedInto: string | null } | { ok: false; error: string }> {
  const office = await requireOfficeProfile();
  if (!office) return { ok: false, error: "Office access required." };
  if (office.role !== "admin") return { ok: false, error: "Only an admin can delete a lead." };
  const id = z.string().uuid().safeParse(leadId);
  if (!id.success) return { ok: false, error: "Invalid lead." };

  const admin = createAdminClient();
  const { data: lead } = await admin
    .from("leads")
    .select("id, name, client_id")
    .eq("id", id.data)
    .maybeSingle();
  if (!lead) return { ok: false, error: "Lead not found." };

  // Hoisted above the guard: whether a sibling lead survives on the same client
  // decides BOTH how the storage check reads and where history is merged, so it
  // must be known before the verdict rather than after it.
  let siblings: { id: string }[] = [];
  if (lead.client_id) {
    const { data, error } = await admin
      .from("leads")
      .select("id")
      .eq("client_id", lead.client_id)
      .neq("id", id.data);
    // Same rule as the counts below: a failed read must not pass as "no
    // siblings", which would both skip the storage guard and lose the history
    // this delete is supposed to merge.
    if (error) return { ok: false, error: `could not check sibling leads: ${error.message}` };
    siblings = (data ?? []) as { id: string }[];
  }

  // storage_lets is deliberately absent: it is client-scoped, so it cannot be
  // counted by lead_id like the rest. See storageLetsBlockingDelete.
  const COUNTED = [
    ["quotes", "quotes"],
    ["appointments", "appointments"],
    ["signatures", "signatures"],
    ["cardPayments", "card_payments"],
    ["cubicSurveys", "cubic_surveys"],
    ["claims", "claims"],
    ["jobCompletions", "job_completions"],
  ] as const;

  let verdict;
  try {
    const facts = {} as Record<(typeof COUNTED)[number][0], number>;
    for (const [key, table] of COUNTED) {
      const { count: n, error } = await admin
        .from(table)
        .select("id", { count: "exact", head: true })
        .eq("lead_id", id.data);
      // A failed count must never read as "nothing there" — that would let a
      // lead carrying money past the guard.
      if (error) throw new Error(`could not check ${table}: ${error.message}`);
      facts[key] = n ?? 0;
    }

    // Only worth asking when this is the last lead on the client — with a
    // sibling surviving, the answer cannot block the delete anyway, so the
    // query is skipped rather than run and discarded.
    let letsOnClient = 0;
    if (lead.client_id && siblings.length === 0) {
      const { count: n, error } = await admin
        .from("storage_lets")
        .select("id", { count: "exact", head: true })
        .eq("client_id", lead.client_id);
      if (error) throw new Error(`could not check storage_lets: ${error.message}`);
      letsOnClient = n ?? 0;
    }

    verdict = canDeleteLead({
      ...facts,
      orphanedStorageLets: storageLetsBlockingDelete({
        clientId: lead.client_id,
        siblingLeadCount: siblings.length,
        letsOnClient,
      }),
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not check the lead." };
  }
  if (!verdict.deletable) {
    return { ok: false, error: `This lead can't be deleted because ${verdict.reason}. Mark it lost instead.` };
  }

  // Exactly one sibling on the same client = a duplicate being merged; keep the
  // history on the survivor. Two or more and we cannot know which it belongs to.
  const mergedInto: string | null = siblings.length === 1 ? siblings[0].id : null;
  if (mergedInto) {
    for (const table of ["activities", "communications", "follow_ups"] as const) {
      await admin.from(table).update({ lead_id: mergedInto }).eq("lead_id", id.data);
    }
  } else {
    // No survivor to keep the history on. Neither FK cascades (follow_ups
    // does), so these rows must go first or Postgres refuses the lead delete —
    // which is exactly what any real lead hit, since creating one writes an
    // activity.
    for (const table of ["activities", "communications"] as const) {
      const { error } = await admin.from(table).delete().eq("lead_id", id.data);
      if (error) return { ok: false, error: "Could not delete the lead." };
    }
  }

  const { error } = await admin.from("leads").delete().eq("id", id.data);
  if (error) return { ok: false, error: "Could not delete the lead." };

  if (mergedInto) {
    await admin.from("activities").insert({
      lead_id: mergedInto,
      client_id: lead.client_id,
      actor_id: office.id,
      type: "note",
      summary: `Duplicate lead deleted (${lead.name ?? "unnamed"}); its history was merged here`,
    });
  }
  revalidatePath("/leads");
  return { ok: true, mergedInto };
}
