import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { normalizeEmail, normalizePhone } from "./phone";
import { formatPersonNameOrNull, formatUkPostcodeOrNull } from "./format";

type DB = SupabaseClient<Database>;
type ClientRow = Database["public"]["Tables"]["clients"]["Row"];

export interface ContactInput {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  postcode?: string | null;
}

export interface ClientMatch {
  client: ClientRow;
  matchedOn: "phone" | "email";
  previousLeadCount: number;
}

/** Read-only: find a live client matching phone (then email). Used for the live dedupe check. */
export async function findExistingClient(
  sb: DB,
  input: { phone?: string | null; email?: string | null },
): Promise<ClientMatch | null> {
  const phone = normalizePhone(input.phone);
  const email = normalizeEmail(input.email);

  let client: ClientRow | null = null;
  let matchedOn: "phone" | "email" = "phone";

  if (phone) {
    const { data } = await sb
      .from("clients")
      .select("*")
      .eq("phone_e164", phone)
      .is("merged_into_id", null)
      .maybeSingle();
    if (data) {
      client = data;
      matchedOn = "phone";
    }
  }
  if (!client && email) {
    const { data } = await sb
      .from("clients")
      .select("*")
      .eq("email_norm", email)
      .is("merged_into_id", null)
      .maybeSingle();
    if (data) {
      client = data;
      matchedOn = "email";
    }
  }
  if (!client) return null;

  const { count } = await sb
    .from("leads")
    .select("*", { count: "exact", head: true })
    .eq("client_id", client.id);

  return { client, matchedOn, previousLeadCount: count ?? 0 };
}

/** Attach to a live client (phone-then-email) or create a new one. Mutating. */
export async function attachOrCreateClient(
  sb: DB,
  input: ContactInput,
): Promise<{ clientId: string; matched: boolean; previousLeadCount: number }> {
  const existing = await findExistingClient(sb, input);
  if (existing) {
    return { clientId: existing.client.id, matched: true, previousLeadCount: existing.previousLeadCount };
  }

  const phone_e164 = normalizePhone(input.phone);
  const { data, error } = await sb
    .from("clients")
    .insert({
      display_name: formatPersonNameOrNull(input.name),
      email: normalizeEmail(input.email),
      phone_raw: input.phone?.trim() || null,
      phone_e164,
      postcode_home: formatUkPostcodeOrNull(input.postcode),
    })
    .select("id")
    .single();

  if (error) {
    // Lost a race on the partial-unique index — re-resolve.
    const retry = await findExistingClient(sb, input);
    if (retry) return { clientId: retry.client.id, matched: true, previousLeadCount: retry.previousLeadCount };
    throw error;
  }
  return { clientId: data.id, matched: false, previousLeadCount: 0 };
}
