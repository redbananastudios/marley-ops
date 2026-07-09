import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

type Sb = SupabaseClient<Database>;

/** Lead statuses that still represent live work — booking a survey for a client
 *  reuses one of these rather than opening a duplicate enquiry. */
const OPEN_STATUSES = ["website_enquiry", "survey_booked", "quoted", "provisional", "confirmed"];

export type EnsureLeadResult =
  | { ok: true; leadId: string; created: boolean }
  | { ok: false; error: string };

/**
 * Every booking hangs off a lead (that's where the funnel, chases and quotes
 * live) — but phone customers often start life as a bare client record. This
 * finds the client's open enquiry, or opens one from their stored contact +
 * address details, so "book a survey for this client" always has a lead.
 */
export async function ensureLeadForClient(
  sb: Sb,
  clientId: string,
  actorId: string | null,
  entryChannel: string = "manual",
): Promise<EnsureLeadResult> {
  const { data: client } = await sb
    .from("clients")
    .select("id, display_name, email, phone_raw, phone_e164, postcode_home, address_line1, town")
    .eq("id", clientId)
    .maybeSingle();
  if (!client) return { ok: false, error: "Client not found" };

  // Reuse the most recent live enquiry rather than duplicating it.
  const { data: open } = await sb
    .from("leads")
    .select("id")
    .eq("client_id", clientId)
    .in("status", OPEN_STATUSES as never[])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (open) return { ok: true, leadId: open.id, created: false };

  const fromAddress = [client.address_line1, client.town].filter(Boolean).join(", ") || null;
  const { data: lead, error } = await sb
    .from("leads")
    .insert({
      client_id: clientId,
      status: "website_enquiry",
      entry_channel: entryChannel as never,
      source_system: "marley_ops",
      name: client.display_name,
      phone: client.phone_raw ?? client.phone_e164,
      email: client.email,
      from_postcode: client.postcode_home,
      from_address: fromAddress,
      submitted_at: new Date().toISOString(),
    } as never)
    .select("id")
    .single();
  if (error || !lead) return { ok: false, error: error?.message ?? "Could not create the enquiry" };

  await sb.from("activities").insert({
    client_id: clientId,
    lead_id: lead.id,
    actor_id: actorId,
    type: "lead_created",
    summary: `Enquiry opened from the client record (${entryChannel.replace(/_/g, " ")})`,
    meta: { via: "client_record" },
  });

  return { ok: true, leadId: lead.id, created: true };
}
