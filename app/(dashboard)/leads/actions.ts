"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { attachOrCreateClient, findExistingClient } from "@/lib/leads/resolver";
import { newLeadSchema, type NewLeadInput } from "@/lib/leads/schema";

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

  const { clientId, matched, previousLeadCount } = await attachOrCreateClient(sb, {
    name: v.name,
    phone: v.phone,
    email: v.email,
    postcode: v.from_postcode,
  });

  const { data: lead, error } = await sb
    .from("leads")
    .insert({
      client_id: clientId,
      estimator_id: userId,
      status: "website_enquiry",
      entry_channel: v.entry_channel,
      referrer_answer: v.referrer_answer || null,
      source_system: "marley_ops",
      name: v.name,
      phone: v.phone || null,
      email: v.email || null,
      from_postcode: v.from_postcode || null,
      to_postcode: v.to_postcode || null,
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

  const { error } = await sb
    .from("leads")
    .update({
      status: status as never,
      ...(stampContact ? { first_contacted_at: new Date().toISOString() } : {}),
    })
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

  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/leads");
  revalidatePath("/");
  return { ok: true as const };
}
