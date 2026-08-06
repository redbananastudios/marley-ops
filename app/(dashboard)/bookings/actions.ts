"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { markBalancePaid, markCommitmentPaid, markDepositPaid } from "@/lib/quote/accept-flow";

/**
 * Bookings-page actions. Payment method is a human statement of fact (how the
 * money actually arrived — bank transfer or cash); the flow core records it in
 * Zoho with the matching payment mode and runs the full paid pipeline
 * (status, chases, customer confirmation email, ops alert).
 */

async function actor() {
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  return { sb, userId: user?.id ?? null };
}

function refresh(leadId?: string | null, quoteId?: string | null) {
  revalidatePath("/bookings");
  revalidatePath("/follow-ups");
  revalidatePath("/");
  if (leadId) revalidatePath(`/leads/${leadId}`);
  if (quoteId) revalidatePath(`/quotes/${quoteId}`);
}

export async function markQuoteDepositPaidAction(
  quoteId: string,
  method: "bank_transfer" | "cash",
) {
  const { sb, userId } = await actor();
  if (!userId) return { ok: false as const, error: "Not signed in" };
  const res = await markDepositPaid(sb, quoteId, { method, actorId: userId, recordInZoho: true });
  if (!res.ok) return { ok: false as const, error: res.error ?? "Could not mark paid" };
  const { data: q } = await sb.from("quotes").select("lead_id").eq("id", quoteId).single();
  refresh(q?.lead_id, quoteId);
  // `already` must survive: the bank feed treats an already-recorded item as a
  // likely DUPLICATE customer payment and refuses to mark its row confirmed.
  return { ok: true as const, already: res.already === true };
}

/** Commitment invoice paid by BACS/cash — runs the full commitment-paid
 *  pipeline (Zoho payment record, T-7 flag cleared, chase closed, customer
 *  receipt). Same `already` contract as deposit/balance: the bank feed treats
 *  an already-recorded commitment as a likely duplicate payment. */
export async function markQuoteCommitmentPaidAction(
  quoteId: string,
  method: "bank_transfer" | "cash",
) {
  const { sb, userId } = await actor();
  if (!userId) return { ok: false as const, error: "Not signed in" };
  const res = await markCommitmentPaid(sb, quoteId, { method, actorId: userId, recordInZoho: true });
  if (!res.ok) return { ok: false as const, error: res.error ?? "Could not mark paid" };
  const { data: q } = await sb.from("quotes").select("lead_id").eq("id", quoteId).single();
  refresh(q?.lead_id, quoteId);
  return { ok: true as const, already: res.already === true };
}

export async function markQuoteBalancePaidAction(
  quoteId: string,
  method: "bank_transfer" | "cash",
) {
  const { sb, userId } = await actor();
  if (!userId) return { ok: false as const, error: "Not signed in" };
  const res = await markBalancePaid(sb, quoteId, userId, true, method);
  if (!res.ok) return { ok: false as const, error: res.error ?? "Could not mark paid" };
  const { data: q } = await sb.from("quotes").select("lead_id").eq("id", quoteId).single();
  refresh(q?.lead_id, quoteId);
  return { ok: true as const, already: res.already === true };
}

/** Pause / resume the chase engine for a lead (one tap from the Bookings row). */
export async function setChasePausedAction(leadId: string, paused: boolean) {
  const { sb, userId } = await actor();
  const { error } = await sb.from("leads").update({ chase_paused: paused } as never).eq("id", leadId);
  if (error) return { ok: false as const, error: error.message };
  await sb.from("activities").insert({
    lead_id: leadId,
    actor_id: userId,
    type: "note",
    summary: paused ? "Chasing paused" : "Chasing resumed",
  });
  refresh(leadId);
  return { ok: true as const };
}
