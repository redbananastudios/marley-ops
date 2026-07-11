"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { computeQuote } from "@/lib/quote/pricing";
import {
  deriveInputs,
  defaultQuoteValues,
  composeAddr,
  type QuoteFormValues,
} from "@/lib/quote/form-types";
import { addressFromString } from "@/lib/places/parse";
import { acceptQuoteByStaff } from "@/lib/quote/accept-flow";
import { markLeadLostAction, createLeadAction } from "@/app/(dashboard)/leads/actions";
import type { NewLeadInput } from "@/lib/leads/schema";
import { getBusinessSettings } from "@/lib/settings";
import { recommendVans } from "@/lib/cubic-survey";
import { getPricingConfig } from "@/lib/quote/pricing-config";
import { ukParts } from "@/lib/uk-time";

async function ctx() {
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  return { sb, userId: user?.id ?? null };
}

/** MM-YYMMDD-NNN with a per-day sequence (avoids the live tool's random-NNN collision risk). */
async function nextQuoteRef(sb: Awaited<ReturnType<typeof createClient>>): Promise<string> {
  const d = ukParts(); // ref date = UK calendar day (server runs UTC)
  const stamp = `${String(d.year).slice(-2)}${String(d.month).padStart(2, "0")}${String(d.day).padStart(2, "0")}`;
  const prefix = `MM-${stamp}-`;
  const { count } = await sb
    .from("quotes")
    .select("id", { count: "exact", head: true })
    .like("quote_ref", `${prefix}%`);
  return `${prefix}${String((count ?? 0) + 1).padStart(3, "0")}`;
}

/** Create a draft quote (optionally pre-filled from a lead) so it exists in the panel immediately. */
export async function createDraftQuote(opts: { leadId?: string } = {}) {
  const { sb, userId } = await ctx();

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
    seed.job.collectAddress = addressFromString(
      [lead.from_address, lead.from_postcode].filter(Boolean).join(", "),
    );
    seed.job.destAddress = addressFromString([lead.to_address, lead.to_postcode].filter(Boolean).join(", "));
    seed.job.collectAddr = composeAddr(seed.job.collectAddress);
    seed.job.destAddr = composeAddr(seed.job.destAddress);

    // Cubic survey → pre-select the recommended vehicle on NEW quotes only
    // (Peter, 2026-07-10). Existing quotes only ever get the suggestion chip.
    const { data: cubic } = await sb
      .from("cubic_surveys")
      .select("total_ft3")
      .eq("lead_id", lead.id)
      .maybeSingle();
    if (cubic && Number(cubic.total_ft3) > 0) {
      const rec = recommendVans(Number(cubic.total_ft3), {
        fillPct: settings.cubicFillPct,
        transitFt3: settings.cubicTransitFt3,
        lutonFt3: settings.cubicLutonFt3,
        sevenFiveTFt3: settings.cubic75tFt3,
      });
      if (rec) seed.vehicle = rec.vehicleKey;
    }
  }
  const pricing = await getPricingConfig(sb);
  const breakdown = computeQuote(deriveInputs(seed), pricing);

  // Retry once on the unlikely ref collision.
  for (let attempt = 0; attempt < 2; attempt++) {
    const quote_ref = await nextQuoteRef(sb);
    const { data, error } = await sb
      .from("quotes")
      .insert({
        quote_ref,
        estimator_id: userId,
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
  const { error } = await sb.from("quotes").delete().eq("id", id);
  if (error) return { ok: false as const, error: error.message };
  revalidatePath("/quotes");
  revalidatePath("/");
  return { ok: true as const };
}

export async function setQuoteStatus(id: string, status: string) {
  // Accepting captures revenue + advances the lead — route through acceptQuote.
  if (status === "accepted") return acceptQuote(id);

  const { sb, userId } = await ctx();
  const { data: q } = await sb.from("quotes").select("lead_id, client_id").eq("id", id).single();
  const { error } = await sb.from("quotes").update({ status: status as never }).eq("id", id);
  if (error) return { ok: false as const, error: error.message };

  // Sending a quote advances the linked lead to Quoted (never regressing a later stage),
  // so the Board reflects reality without a manual status move.
  if (status === "sent" && q?.lead_id) {
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
