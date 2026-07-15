"use server";

import { createClient } from "@/lib/supabase/server";
import { requireOfficeProfile } from "@/lib/ai/auth";
import {
  EMPTY_RESULTS,
  MIN_SEARCH_LEN,
  sanitiseSearchTerm,
  type GlobalSearchResults,
} from "@/components/search/search-utils";

/** Max hits per group — keeps the palette scannable and each query cheap. */
const LIMIT = 6;

/**
 * Office-gated quick search across leads, clients and quotes.
 *
 * Three narrow ilike lookups run in PARALLEL (no joins, minimal columns) so the
 * palette stays snappy. RLS + the requireOfficeProfile gate keep this office-
 * only; crew never see the palette and would be denied here anyway.
 */
export async function globalSearchAction(q: string): Promise<GlobalSearchResults> {
  const office = await requireOfficeProfile();
  if (!office) return EMPTY_RESULTS;

  const term = sanitiseSearchTerm(q);
  if (term.length < MIN_SEARCH_LEN) return EMPTY_RESULTS;

  const supabase = await createClient();
  const like = `%${term}%`;

  const [leadsRes, clientsRes, quotesRes] = await Promise.all([
    supabase
      .from("leads")
      .select("id, name, status, from_postcode, to_postcode")
      .or(
        `name.ilike.${like},from_postcode.ilike.${like},to_postcode.ilike.${like},email.ilike.${like},phone.ilike.${like}`,
      )
      .order("created_at", { ascending: false })
      .limit(LIMIT),
    supabase
      .from("clients")
      .select("id, display_name, email, phone_e164, phone_raw")
      .or(
        `display_name.ilike.${like},email.ilike.${like},phone_raw.ilike.${like},phone_e164.ilike.${like}`,
      )
      .order("created_at", { ascending: false })
      .limit(LIMIT),
    supabase
      .from("quotes")
      .select("id, quote_ref, customer_name, status")
      .or(`quote_ref.ilike.${like},customer_name.ilike.${like}`)
      .order("created_at", { ascending: false })
      .limit(LIMIT),
  ]);

  return {
    leads: (leadsRes.data ?? []).map((l) => ({
      id: l.id,
      name: l.name,
      status: l.status,
      fromPostcode: l.from_postcode,
      toPostcode: l.to_postcode,
    })),
    clients: (clientsRes.data ?? []).map((c) => ({
      id: c.id,
      name: c.display_name,
      subtitle: c.email ?? c.phone_raw ?? c.phone_e164 ?? null,
    })),
    quotes: (quotesRes.data ?? []).map((qr) => ({
      id: qr.id,
      ref: qr.quote_ref,
      name: qr.customer_name,
      status: qr.status,
    })),
  };
}
