"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { computeQuote } from "@/lib/quote/pricing";
import {
  deriveInputs,
  defaultQuoteValues,
  composeAddr,
  type QuoteFormValues,
} from "@/lib/quote/form-types";
import { addressFromLead } from "@/lib/places/parse";
import { acceptQuoteByStaff } from "@/lib/quote/accept-flow";
import { markLeadLostAction, createLeadAction } from "@/app/(dashboard)/leads/actions";
import type { NewLeadInput } from "@/lib/leads/schema";
import { getBusinessSettings } from "@/lib/settings";
import { recommendVans } from "@/lib/cubic-survey";
import { getSurveyPlanningState } from "@/lib/ai/planning";
import { getPricingConfig } from "@/lib/quote/pricing-config";
import { quoteRefKind } from "@/lib/quote/ref";
import { planSupersede, refList, type SiblingQuote } from "@/lib/quote/supersede";

async function ctx() {
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  return { sb, userId: user?.id ?? null };
}

/**
 * Allocate the next quote reference — MMR### (residential) or MMC### (commercial),
 * an ever-growing per-kind counter minted by the DB sequence via next_quote_ref()
 * (migration 0037). Collision-proof even when quotes are deleted (unlike the old
 * count-of-rows-today scheme). Throws only on a genuine RPC failure.
 */
async function nextQuoteRef(
  sb: Awaited<ReturnType<typeof createClient>>,
  kind: "R" | "C",
): Promise<string> {
  const { data, error } = await sb.rpc("next_quote_ref", { kind });
  if (error || typeof data !== "string") {
    throw new Error(error?.message ?? "Could not allocate a quote reference");
  }
  return data;
}

/**
 * The quote this lead is already working to, if any — the newest live one
 * (superseded and rejected rows are history; a draft is unfinished work worth
 * resuming). Used by the diary's survey actions: the estimator sometimes quotes
 * before attending (Peter, 2026-08-10), so "Create Quote" would otherwise open a
 * blank builder and throw away pricing already done, or send a second quote to a
 * customer holding the first.
 */
export async function liveQuoteForLead(leadId: string) {
  const { sb } = await ctx();
  const { data } = await sb
    .from("quotes")
    .select("id, quote_ref, status")
    .eq("lead_id", leadId)
    .in("status", ["draft", "sent", "accepted"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ? { id: data.id, quoteRef: data.quote_ref, status: data.status } : null;
}

/** Create a draft quote (optionally pre-filled from a lead) so it exists in the panel immediately. */
export async function createDraftQuote(opts: { leadId?: string } = {}) {
  const { sb } = await ctx();

  // Resume an existing open DRAFT for this lead rather than piling up orphan drafts
  // each time "Quote without survey" / "New quote" is opened (Peter, 2026-08-02:
  // "we end up with multiple drafts"). Only a draft is resumed — a sent/accepted
  // quote is history, so "New quote" from there deliberately starts a fresh draft.
  // Newest draft wins if a lead already accumulated several.
  if (opts.leadId) {
    const { data: existingDraft } = await sb
      .from("quotes")
      .select("id, quote_ref")
      .eq("lead_id", opts.leadId)
      .eq("status", "draft")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existingDraft) return { ok: true as const, id: existingDraft.id, quoteRef: existingDraft.quote_ref };
  }

  let lead = null;
  if (opts.leadId) {
    const { data } = await sb.from("leads").select("*").eq("id", opts.leadId).single();
    lead = data;
  }

  // Seed the wizard state so the form opens pre-filled. The wizard hydrates from
  // state_blob, so without this a quote created from a lead would show empty fields.
  const settings = await getBusinessSettings(sb);
  const seed: QuoteFormValues = defaultQuoteValues();
  seed.vatEnabled = settings.vatDefault; // VAT default from settings
  if (lead) {
    seed.customer = { name: lead.name ?? "", phone: lead.phone ?? "", email: lead.email ?? "" };
    // Parse "street, town" + postcode into the structured fields so the form opens
    // with each part in its own input (not everything dumped into Street address).
    // Website-sync leads keep the postcode in from_postcode/to_postcode SEPARATELY
    // from the address line, so addressFromLead re-joins them (without doubling a
    // postcode a manual lead already baked into from_address) — otherwise the town
    // and postcode were silently dropped (Peter, 2026-08-02). Same for destination.
    seed.job.collectAddress = addressFromLead(lead.from_address, lead.from_postcode);
    seed.job.destAddress = addressFromLead(lead.to_address, lead.to_postcode);
    seed.job.collectAddr = composeAddr(seed.job.collectAddress);
    seed.job.destAddr = composeAddr(seed.job.destAddress);
    // Carry the lead's requested move date into the wizard. It is the customer's
    // PREFERRED date (not yet confirmed), so open it flagged as an estimate.
    // Without this the date entered on the lead was silently lost when the quote
    // form opened (Peter, 2026-07-30).
    if (lead.preferred_date) {
      seed.job.moveDate = lead.preferred_date as string;
      seed.job.moveDateEstimated = true;
    }

    // Cubic survey → pre-select the recommended vehicle on NEW quotes only
    // (Peter, 2026-07-10). Existing quotes only ever get the suggestion chip.
    const { data: cubic } = await sb
      .from("cubic_surveys")
      .select("total_ft3, ai_status, planning_ready, contingency_pct")
      .eq("lead_id", lead.id)
      .maybeSingle();
    if (cubic && Number(cubic.total_ft3) > 0) {
      const planning = getSurveyPlanningState({ rawFt3: Number(cubic.total_ft3), aiStatus: cubic.ai_status, planningReady: cubic.planning_ready, contingencyPct: cubic.contingency_pct });
      const rec = planning.guidanceReady ? recommendVans(planning.planningFt3, {
        fillPct: settings.cubicFillPct,
        transitFt3: settings.cubicTransitFt3,
        lutonFt3: settings.cubicLutonFt3,
        sevenFiveTFt3: settings.cubic75tFt3,
      }) : null;
      if (rec) seed.vehicle = rec.vehicleKey;
    }
  }
  const pricing = await getPricingConfig(sb);
  const breakdown = computeQuote(deriveInputs(seed), pricing);

  // Residential vs commercial reference (MMR###/MMC###), from the lead's move type.
  const kind = quoteRefKind(lead?.property_size);

  // Retry once on the unlikely ref collision (a fresh sequence value each pass
  // can never collide — this is a belt-and-braces backstop).
  for (let attempt = 0; attempt < 2; attempt++) {
    let quote_ref: string;
    try {
      quote_ref = await nextQuoteRef(sb, kind);
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : "Could not allocate a quote reference" };
    }
    const { data, error } = await sb
      .from("quotes")
      .insert({
        quote_ref,
        // New quotes start UNASSIGNED — NOT owned by whoever clicked "New quote".
        // The estimator is set deliberately on the review step (EstimatorPicker),
        // so an un-triaged quote emails from the Accounts money desk rather than
        // from the office admin who created it (Peter, 2026-07-30: "Leanne was
        // wrong"). estimator_id is a nullable FK; pay attribution only ever reads
        // it as a last-resort fallback after the lead/survey owner, so null here
        // is safe. The office assigns it to the real estimator via the picker.
        estimator_id: null,
        lead_id: lead?.id ?? null,
        client_id: lead?.client_id ?? null,
        status: "draft",
        customer_name: seed.customer.name || null,
        customer_email: seed.customer.email || null,
        customer_phone: seed.customer.phone || null,
        collect_addr: seed.job.collectAddr || null,
        dest_addr: seed.job.destAddr || null,
        state_blob: seed as never,
        breakdown: breakdown as never,
        subtotal: breakdown.subtotal,
        vat_enabled: breakdown.vatEnabled,
        vat_amount: breakdown.vatAmount,
        grand_total: breakdown.grandTotal,
      })
      .select("id, quote_ref")
      .single();
    if (!error) {
      // No revalidatePath here: createDraftQuote is also called during the
      // /quotes/new server render, where revalidatePath is unsupported. The
      // redirect target + the force-dynamic /quotes list refetch on nav anyway.
      return { ok: true as const, id: data.id, quoteRef: data.quote_ref };
    }
    // A concurrent call minted this lead's draft first (partial unique index
    // quotes_one_draft_per_lead_uq, migration 0101). /quotes/new creates the
    // draft during its render, which Next can fire twice for one navigation,
    // and both passes clear the resume check above before either commits —
    // the other row IS the draft the user wanted, so hand it back rather than
    // retrying into the same wall or burning a second quote_ref.
    if (opts.leadId && error.message.includes("quotes_one_draft_per_lead_uq")) {
      const { data: winner } = await sb
        .from("quotes")
        .select("id, quote_ref")
        .eq("lead_id", opts.leadId)
        .eq("status", "draft")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (winner) return { ok: true as const, id: winner.id, quoteRef: winner.quote_ref };
      // Winner vanished between the violation and the re-read (draft deleted)
      // — fall through so the duplicate branch below retries the insert.
    }
    if (!error.message.includes("duplicate") && !error.message.includes("unique")) {
      return { ok: false as const, error: error.message };
    }
  }
  return { ok: false as const, error: "Could not allocate a quote reference" };
}

/**
 * Create a lead (client dedupe + capture the move details) AND a draft quote
 * seeded from it, in one step — the "New quote" flow (Peter, 2026-07-11: every
 * quote should belong to a client→lead, no orphan quotes). Returns the quote id.
 */
export async function createQuoteWithLeadAction(
  input: NewLeadInput,
): Promise<{ ok: true; quoteId: string } | { ok: false; error: string }> {
  const leadRes = await createLeadAction(input);
  if (!leadRes.ok) return { ok: false, error: leadRes.error };
  const quoteRes = await createDraftQuote({ leadId: leadRes.leadId });
  if (!quoteRes.ok) return { ok: false, error: quoteRes.error };
  return { ok: true, quoteId: quoteRes.id };
}

/**
 * Create the lead + draft quote and land the user in the builder via a
 * SERVER-SIDE redirect (see createLeadAndOpenAction for the why: the old
 * client router.push raced the server action's revalidation and reliably
 * bounced back to the empty /quotes/new form, creating duplicate drafts). On a
 * validation error it returns {ok:false} for the form to surface; on success it
 * never returns — the redirect performs the navigation atomically.
 */
export async function createQuoteWithLeadAndOpenAction(input: NewLeadInput) {
  const res = await createQuoteWithLeadAction(input);
  if (!res.ok) return { ok: false as const, error: res.error };
  redirect(`/quotes/${res.quoteId}`);
}

/** Persist wizard state + the computed breakdown. Money columns always come from computeQuote(). */
export async function saveQuoteDraft(id: string, values: QuoteFormValues) {
  const { sb } = await ctx();
  const pricing = await getPricingConfig(sb);
  const b = computeQuote(deriveInputs(values), pricing);

  const { error } = await sb
    .from("quotes")
    .update({
      state_blob: values as never,
      breakdown: b as never,
      customer_name: values.customer.name || null,
      customer_email: values.customer.email || null,
      customer_phone: values.customer.phone || null,
      collect_addr: values.job.collectAddr || null,
      dest_addr: values.job.destAddr || null,
      moving_date: values.job.moveDate || null,
      moving_date_estimated: values.job.moveDateEstimated,
      vehicle: values.vehicle,
      packing: values.packing,
      subtotal: b.subtotal,
      discount: b.discount,
      vat_enabled: b.vatEnabled,
      vat_amount: b.vatAmount,
      grand_total: b.grandTotal,
      total_miles: b.totalMiles,
    })
    .eq("id", id);

  if (error) return { ok: false as const, error: error.message };
  revalidatePath(`/quotes/${id}`);
  revalidatePath("/quotes");
  return { ok: true as const };
}

/**
 * Assign (or clear) the estimator who OWNS this quote. This decides who a quote
 * EMAIL fronts (lib/comms/sender.ownerIdentity -> "Luke at Marley Moves
 * <luke@marleymoves.co.uk>") and, as a last-resort fallback, pay attribution.
 * Passing null leaves it UNASSIGNED so the email sends from the Accounts money
 * desk, never whichever office admin created or sent it (Peter, 2026-07-30).
 * Office-gated (admin OR estimator): both office roles build and own quotes, but
 * crew must never touch ownership. Tighter than the is_staff() RLS on quotes.
 */
export async function setQuoteEstimator(quoteId: string, estimatorId: string | null) {
  const profile = await getSessionProfile();
  if (!profile) return { ok: false as const, error: "Not signed in." };
  if (profile.role !== "admin" && profile.role !== "estimator") {
    return { ok: false as const, error: "Office only." };
  }
  const { sb } = await ctx();
  const { error } = await sb.from("quotes").update({ estimator_id: estimatorId }).eq("id", quoteId);
  if (error) return { ok: false as const, error: error.message };
  revalidatePath(`/quotes/${quoteId}`);
  return { ok: true as const };
}

/** Delete a quote. Drafts/rejected go freely; the UI gates sent/accepted behind an
 *  extra confirm (deleting an accepted quote removes a recorded win). A quote
 *  carrying a SIGNED CONTRACT is never deletable — the signature row would be
 *  orphaned (quote_id nulls out) and the evidence unreachable. */
export async function deleteQuote(id: string) {
  const { sb } = await ctx();
  const { data: signed } = await sb
    .from("signatures")
    .select("id")
    .eq("quote_id", id)
    .limit(1)
    .maybeSingle();
  if (signed) {
    return {
      ok: false as const,
      error: "This quote carries a signed contract — it can't be deleted. Reject it instead if it's no longer live.",
    };
  }
  // An accepted quote that carries MONEY (a paid deposit or any raised Zoho
  // invoice) must not be deletable — deleting it would drop a recorded payment /
  // live invoice off the books. The quotes-list delete widened who can reach this
  // action, so guard the money here, not just at the UI (reviewer, 2026-07-30).
  const { data: q } = await sb
    .from("quotes")
    .select("status, deposit_paid_at, zoho_deposit_invoice_id, zoho_balance_invoice_id, zoho_commitment_invoice_id")
    .eq("id", id)
    .maybeSingle();
  const realZoho = (v: string | null | undefined): boolean => !!v && v !== "pending";
  if (
    q?.status === "accepted" &&
    (q.deposit_paid_at ||
      realZoho(q.zoho_deposit_invoice_id) ||
      realZoho(q.zoho_balance_invoice_id) ||
      realZoho(q.zoho_commitment_invoice_id))
  ) {
    return {
      ok: false as const,
      error:
        "This accepted quote has money against it (a paid deposit or a raised invoice) — it can't be deleted. Cancel the booking and handle any refund first.",
    };
  }
  // card_payments and refund_queue reference the quote with ON DELETE RESTRICT —
  // correctly, that is real money. Check them here so the office reads a sentence
  // instead of a raw constraint name from Postgres (Peter, 2026-08-10 hit exactly
  // that on the communications FK, since fixed in 0092 to SET NULL: the email
  // reached the customer and its record outlives the quote).
  const [{ count: cardCount }, { count: refundCount }] = await Promise.all([
    sb.from("card_payments").select("id", { count: "exact", head: true }).eq("quote_id", id),
    sb.from("refund_queue").select("id", { count: "exact", head: true }).eq("quote_id", id),
  ]);
  if ((cardCount ?? 0) > 0 || (refundCount ?? 0) > 0) {
    return {
      ok: false as const,
      error:
        "This quote has a card payment or refund recorded against it, so it can't be deleted. Reject it instead — that retires it without losing the money trail.",
    };
  }
  const { error } = await sb.from("quotes").delete().eq("id", id);
  if (error) return { ok: false as const, error: error.message };
  revalidatePath("/quotes");
  revalidatePath("/");
  return { ok: true as const };
}

export async function setQuoteStatus(id: string, status: string) {
  // Accepting captures revenue + advances the lead — route through acceptQuote.
  if (status === "accepted") return acceptQuote(id);
  // This generic setter is for the pre-acceptance states ONLY. Rejecting or
  // superseding an accepted quote must unwind the live booking + Zoho invoices +
  // deposit (rejectQuote / markLeadLost do that) — a raw status write here would
  // leave those live under a quote that reads rejected.
  if (status !== "draft" && status !== "sent") {
    return { ok: false as const, error: "That status can’t be set here — use Reject, or supersede with a new quote." };
  }

  const { sb, userId } = await ctx();
  const { data: q } = await sb.from("quotes").select("lead_id, client_id, status, quote_ref").eq("id", id).single();
  const newRef = q?.quote_ref ?? null;
  if (q?.status === "accepted") {
    return { ok: false as const, error: "This quote is accepted — reject or supersede it so the booking and invoices unwind properly." };
  }
  const { error } = await sb.from("quotes").update({ status: status as never }).eq("id", id);
  if (error) return { ok: false as const, error: error.message };

  // Sending a quote advances the linked lead to Quoted (never regressing a later stage),
  // so the Board reflects reality without a manual status move.
  if (status === "sent" && q?.lead_id) {
    // The survey's "build and send the quote" reminder is done the moment the
    // quote goes out — close it, or it sits on /follow-ups going overdue telling
    // the estimator to do a job they've already finished (Alina, 2026-08-07:
    // the reminder even races the quote insert inside the complete-survey flow,
    // so it exists on virtually every surveyed job). Scoped to survey_completed:
    // chase-engine call tasks ("give them a call") stay open until accept/deposit.
    const { data: surveyFus } = await sb
      .from("follow_ups")
      .select("id")
      .eq("lead_id", q.lead_id)
      .eq("reason", "quote_followup")
      .eq("source", "survey_completed")
      .eq("status", "open");
    for (const fu of surveyFus ?? []) {
      await sb.from("follow_ups").update({ status: "cancelled", outcome: "cancelled" }).eq("id", fu.id);
    }
    if (surveyFus?.length) revalidatePath("/follow-ups");

    // A fresh quote arms a fresh chase cadence. dueChaseStep measures the
    // lead's quote_chase_step against THIS quote's email_sent_at, but nothing
    // ever reset that counter — so a customer who had been chased 3 times on an
    // earlier quote got ZERO follow-ups on the revised one (dueChaseStep returns
    // null once completedSteps >= days.length), then lapsed to "lost — no
    // response" 30 days later. A partially-advanced counter was just as wrong:
    // the only chase to fire was step 3, whose copy invites the customer to
    // reply "not going ahead" about a quote sent yesterday. deposit_chase_step
    // is already reset this way on acceptance; this is the same idea for the
    // quote ladder, and un-pausing matches that precedent — sending a revised
    // quote IS the fresh context, even if an earlier reply paused chasing.
    const { error: chaseResetError } = await sb
      .from("leads")
      .update({ quote_chase_step: 0, quote_chase_at: null, chase_paused: false } as never)
      .eq("id", q.lead_id);
    if (chaseResetError) {
      return { ok: false as const, error: `The quote was sent but its follow-up schedule could not be reset: ${chaseResetError.message}` };
    }

    const { data: lead } = await sb
      .from("leads")
      .select("status, first_contacted_at")
      .eq("id", q.lead_id)
      .single();
    if (lead && FUNNEL.indexOf(lead.status) < FUNNEL.indexOf("quoted")) {
      const patch: Record<string, unknown> = { status: "quoted" };
      if (!lead.first_contacted_at) patch.first_contacted_at = new Date().toISOString();
      await sb.from("leads").update(patch as never).eq("id", q.lead_id);
      await sb.from("activities").insert({
        lead_id: q.lead_id,
        client_id: q.client_id,
        actor_id: userId,
        type: "status_change",
        summary: "Quote sent — moved to Quoted",
        meta: { quote_id: id, from: lead.status, to: "quoted" },
      });
      revalidatePath(`/leads/${q.lead_id}`);
      revalidatePath("/leads");
    }

    // Retire the quote this one replaces. Superseding used to happen only on
    // ACCEPT, so a revision left the original live: two prices in the customer's
    // inbox, two rows in Awaiting reply and open pipeline, and a chase ladder
    // that could follow up on the number we had just corrected.
    // Best-effort by design — the email has already reached the customer at this
    // point, so a failure here must report, never unsend.
    const { data: siblings } = await sb
      .from("quotes")
      .select("id, quote_ref, status, deposit_paid_at, zoho_deposit_invoice_id, zoho_balance_invoice_id, zoho_commitment_invoice_id")
      .eq("lead_id", q.lead_id)
      .neq("id", id);
    const plan = planSupersede((siblings ?? []) as SiblingQuote[], id);
    for (const old of plan.supersede) {
      const { error: supError } = await sb
        .from("quotes")
        .update({ status: "superseded" } as never)
        .eq("id", old.id)
        .eq("status", "sent"); // CAS: don't retire one the customer accepted mid-send
      if (supError) continue;
      await sb.from("activities").insert({
        lead_id: q.lead_id,
        client_id: q.client_id,
        actor_id: userId,
        type: "note",
        summary: `Quote ${old.quote_ref ?? "(no ref)"} superseded by ${newRef ?? "the new quote"}`,
        meta: { superseded_quote_id: old.id, by_quote_id: id },
      });
    }
    if (plan.supersede.length || plan.blocked.length) revalidatePath("/quotes");
    if (plan.blocked.length) {
      // Money is attached, so retiring it silently could strand an invoice or a
      // taken payment. Say so plainly rather than leaving a live duplicate the
      // office never hears about.
      return {
        ok: true as const,
        warning: `Sent. ${refList(plan.blocked)} is still live and has money against it — reject or refund it so the customer isn't holding two quotes.`,
      };
    }
  }

  revalidatePath(`/quotes/${id}`);
  revalidatePath("/quotes");
  return { ok: true as const };
}

const FUNNEL = ["website_enquiry", "survey_booked", "quoted", "provisional", "confirmed", "completed"];

/**
 * Reject a sent quote with a required reason (Peter, 2026-07-10: the quote
 * page had no "too expensive"-style reject like the lead's Mark-lost). Mirrors
 * the customer's online decline: quote → rejected + reason recorded (feeds the
 * Performance "why we lose" breakdown). The lead is only marked lost when this
 * was its LAST live quote — rejecting a superseded-but-still-sent revision
 * never kills a lead that has a newer quote in play. Accepted quotes don't
 * take this path: cancelling a booked job is the lead's Mark-lost (which
 * unwinds appointments + Zoho invoices).
 */
export async function rejectQuote(id: string, reason: string, note?: string) {
  const VALID = ["too_expensive", "chose_competitor", "move_fell_through", "dates_didnt_work", "no_response", "other"];
  if (!VALID.includes(reason)) return { ok: false as const, error: "Pick a reason" };
  const { sb, userId } = await ctx();
  if (!userId) return { ok: false as const, error: "Not signed in" };

  const { data: q } = await sb
    .from("quotes")
    .select("id, quote_ref, status, lead_id, client_id")
    .eq("id", id)
    .maybeSingle();
  if (!q) return { ok: false as const, error: "Quote not found" };
  if (q.status === "rejected") return { ok: true as const, leadLost: false };
  if (q.status === "accepted") {
    return { ok: false as const, error: "This quote is accepted — cancel the booking with Mark lost on the lead instead." };
  }
  if (q.status !== "sent") {
    return { ok: false as const, error: "Only a sent quote can be rejected. Drafts can just be deleted." };
  }

  const { data: won } = await sb
    .from("quotes")
    .update({ status: "rejected", declined_at: new Date().toISOString(), declined_reason: reason } as never)
    .eq("id", id)
    .eq("status", "sent")
    .select("id");
  if (!won?.length) return { ok: false as const, error: "The quote just changed — refresh and check its status." };

  let leadLost = false;
  if (q.lead_id) {
    const { data: others } = await sb
      .from("quotes")
      .select("id")
      .eq("lead_id", q.lead_id)
      .in("status", ["sent", "accepted"])
      .neq("id", id)
      .limit(1);

    if (!others?.length) {
      const res = await markLeadLostAction(q.lead_id, reason, note);
      leadLost = res.ok === true;
    } else {
      await sb.from("activities").insert({
        lead_id: q.lead_id,
        client_id: q.client_id,
        actor_id: userId,
        type: "status_change",
        summary: `Quote ${q.quote_ref} rejected — ${reason.replace(/_/g, " ")}${note?.trim() ? ` ("${note.trim()}")` : ""} (lead stays live — another quote is still in play)`,
        meta: { quote_id: id, lost_reason: reason },
      });
    }
    revalidatePath(`/leads/${q.lead_id}`);
    revalidatePath("/leads");
  }

  revalidatePath(`/quotes/${id}`);
  revalidatePath("/quotes");
  revalidatePath("/");
  return { ok: true as const, leadLost };
}

/**
 * Accept a quote (staff-side: "Mark accepted" on the quote, "Mark won" on the
 * lead, or the status control). Runs the SAME machine as the customer's online
 * accept — lead to PROVISIONAL, £deposit requested + Zoho deposit invoice,
 * payment email to the customer, day-5 call task — so every accepted quote
 * lands in Bookings → Awaiting deposit and confirms itself when the money
 * arrives. The full pipeline lives in lib/quote/accept-flow.ts.
 */
export async function acceptQuote(id: string, agreedPrice?: number, depositAmount?: number) {
  const { sb, userId } = await ctx();
  if (!userId) return { ok: false as const, error: "Not signed in" };

  const res = await acceptQuoteByStaff(sb, id, userId, agreedPrice, depositAmount);
  if (!res.ok) return { ok: false as const, error: res.error };

  const { data: q } = await sb.from("quotes").select("lead_id").eq("id", id).single();
  if (q?.lead_id) {
    revalidatePath(`/leads/${q.lead_id}`);
    revalidatePath("/leads");
  }
  revalidatePath(`/quotes/${id}`);
  revalidatePath("/quotes");
  revalidatePath("/bookings");
  revalidatePath("/follow-ups");
  revalidatePath("/");
  return {
    ok: true as const,
    agreedPrice: res.agreed,
    deposit: res.deposit,
    emailed: res.emailed,
    alreadyAccepted: res.alreadyAccepted,
  };
}
