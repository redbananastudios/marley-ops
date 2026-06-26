"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { computeQuote } from "@/lib/quote/pricing";
import {
  deriveInputs,
  defaultQuoteValues,
  composeAddr,
  BLANK_QUOTE_ADDRESS,
  type QuoteFormValues,
} from "@/lib/quote/form-types";
import { getBusinessSettings } from "@/lib/settings";
import { getPricingConfig } from "@/lib/quote/pricing-config";

async function ctx() {
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  return { sb, userId: user?.id ?? null };
}

/** MM-YYMMDD-NNN with a per-day sequence (avoids the live tool's random-NNN collision risk). */
async function nextQuoteRef(sb: Awaited<ReturnType<typeof createClient>>): Promise<string> {
  const d = new Date();
  const stamp = `${String(d.getFullYear()).slice(-2)}${String(d.getMonth() + 1).padStart(2, "0")}${String(
    d.getDate(),
  ).padStart(2, "0")}`;
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
    seed.job.collectAddress = {
      ...BLANK_QUOTE_ADDRESS,
      line1: lead.from_address ?? "",
      postcode: lead.from_postcode ?? "",
    };
    seed.job.destAddress = {
      ...BLANK_QUOTE_ADDRESS,
      line1: lead.to_address ?? "",
      postcode: lead.to_postcode ?? "",
    };
    seed.job.collectAddr = composeAddr(seed.job.collectAddress);
    seed.job.destAddr = composeAddr(seed.job.destAddress);
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
 *  extra confirm (deleting an accepted quote removes a recorded win). */
export async function deleteQuote(id: string) {
  const { sb } = await ctx();
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
 * Accept a quote: record the agreed price (the booked revenue — may differ from
 * the quoted total), stamp accepted_at, advance the linked lead to Confirmed
 * (never regressing), stamp first contact if missing, and log it.
 */
export async function acceptQuote(id: string, agreedPrice?: number) {
  const { sb, userId } = await ctx();
  const { data: q, error: qErr } = await sb
    .from("quotes")
    .select("lead_id, client_id, grand_total")
    .eq("id", id)
    .single();
  if (qErr || !q) return { ok: false as const, error: qErr?.message ?? "Quote not found" };

  const price =
    typeof agreedPrice === "number" && Number.isFinite(agreedPrice) && agreedPrice > 0
      ? agreedPrice
      : Number(q.grand_total ?? 0);

  const { error } = await sb
    .from("quotes")
    .update({ status: "accepted" as never, agreed_price: price, accepted_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return { ok: false as const, error: error.message };

  if (q.lead_id) {
    const { data: lead } = await sb
      .from("leads")
      .select("status, first_contacted_at")
      .eq("id", q.lead_id)
      .single();
    const patch: Record<string, unknown> = {};
    if (lead && FUNNEL.indexOf(lead.status) < FUNNEL.indexOf("confirmed")) patch.status = "confirmed";
    if (lead && !lead.first_contacted_at) patch.first_contacted_at = new Date().toISOString();
    if (Object.keys(patch).length) await sb.from("leads").update(patch as never).eq("id", q.lead_id);

    await sb.from("activities").insert({
      lead_id: q.lead_id,
      client_id: q.client_id,
      actor_id: userId,
      type: "status_change",
      summary: `Quote accepted — agreed £${price.toFixed(0)}`,
      meta: { quote_id: id, agreed_price: price },
    });
    revalidatePath(`/leads/${q.lead_id}`);
    revalidatePath("/leads");
  }

  revalidatePath(`/quotes/${id}`);
  revalidatePath("/quotes");
  revalidatePath("/");
  return { ok: true as const, agreedPrice: price };
}
