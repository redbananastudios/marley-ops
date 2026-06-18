"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { computeQuote } from "@/lib/quote/pricing";
import { deriveInputs, type QuoteFormValues } from "@/lib/quote/form-types";

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
        customer_name: lead?.name ?? null,
        customer_email: lead?.email ?? null,
        customer_phone: lead?.phone ?? null,
        collect_addr: lead?.from_postcode ?? null,
        dest_addr: lead?.to_postcode ?? null,
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
  const b = computeQuote(deriveInputs(values));

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

export async function setQuoteStatus(id: string, status: string) {
  const { sb } = await ctx();
  const { error } = await sb.from("quotes").update({ status: status as never }).eq("id", id);
  if (error) return { ok: false as const, error: error.message };
  revalidatePath(`/quotes/${id}`);
  revalidatePath("/quotes");
  return { ok: true as const };
}
