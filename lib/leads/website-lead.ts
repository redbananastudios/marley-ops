import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { attachOrCreateClient } from "@/lib/leads/resolver";
import { formatPersonNameOrNull, formatUkPostcodeOrNull } from "@/lib/leads/format";
import { isFreshEnquiryTimestamp } from "@/lib/push/categories";

type Sb = SupabaseClient<Database>;
type LeadStatus = Database["public"]["Enums"]["lead_status"];

/**
 * Landing a website enquiry as a lead — the ONE code path.
 *
 * The same enquiry can reach us two ways: the Sanity sync PULLS it (up to ~3h
 * behind, and only because the site writes the customer's details into a
 * world-readable dataset), and the ingest route takes it as a direct PUSH from
 * the site the moment it is submitted. Both must produce an identical row, or
 * the panel starts behaving differently depending on how a lead happened to
 * arrive — so normalisation, client resolution, field mapping and the alarm
 * rules live here rather than in either caller, and neither can drift.
 *
 * Idempotency is keyed on BOTH ids a submission can carry, checked in that
 * order. That is what makes running the two routes side by side safe: the site
 * stamps its own `leadId` onto the Sanity document as well as the direct post,
 * so whichever delivery arrives second finds the row the first one landed
 * instead of creating a twin.
 *
 * The site's id lives in `external_lead_id`, NOT in `sanity_id`. `sanity_id`
 * names a Sanity document and is minted by Sanity; putting a second writer's
 * different id space into it would mean the sync looks up a document id, misses,
 * and inserts a duplicate customer the moment both routes are live. Two columns,
 * two id spaces, one row that can carry both — and either route recognises the
 * other's work.
 */

/** Marketing attribution carried from the website. Field names mirror the
 *  site's own payload so a caller hands its object straight over. */
export interface WebsiteLeadAttribution {
  campaign?: string | null;
  variantKey?: string | null;
  landingUrl?: string | null;
  landingReferrer?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  utmContent?: string | null;
  utmTerm?: string | null;
  utmId?: string | null;
  gclid?: string | null;
  gbraid?: string | null;
  wbraid?: string | null;
  fbclid?: string | null;
  msclkid?: string | null;
  ttclid?: string | null;
  liFatId?: string | null;
  posthogDistinctId?: string | null;
}

export interface WebsiteLeadInput {
  /** Which brand's website this enquiry belongs to. REQUIRED and never taken
   *  from the payload: the push route derives it from the matched ingest
   *  secret, the Sanity pull rail stamps `marley` (it is Marley's site only).
   *  Scopes the idempotency key — each brand's site mints its own submission
   *  ids, so the same id under two brands is two different enquiries. */
  brand: string;
  /** The id the SITE minted for this submission. Stable across delivery
   *  attempts AND across both delivery routes — the primary idempotency key,
   *  unique per brand, not globally (migration 0106). */
  externalLeadId?: string | null;
  /** The Sanity document id. Only the sync path has one. */
  sanityId?: string | null;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  fromPostcode?: string | null;
  toPostcode?: string | null;
  propertySize?: string | null;
  /** Free text from the customer ("ASAP", "2-3 weeks") — coerced, not trusted. */
  preferredDate?: string | null;
  services?: string[] | null;
  notes?: string | null;
  /** Which form on the site produced this ("homepage_hero_2step"). */
  sourceForm?: string | null;
  /** The customer's own "How did you hear about us?" answer. */
  referrerAnswer?: string | null;
  /** Already resolved by the caller to a real timestamp (or null). */
  submittedAt?: string | null;
  /** Funnel status on INSERT only. A fresh enquiry is `website_enquiry`; the
   *  sync maps a Sanity status because its documents can be older than us. */
  status?: LeadStatus;
  attribution?: WebsiteLeadAttribution | null;
}

export type LandedWebsiteLead = {
  leadId: string;
  created: boolean;
  /** The timestamp the alarm/push freshness rules were judged against. */
  alertSubmittedAt: string | null;
  /** Present only when the lead already existed — the sync's one-shot alarm
   *  repair needs these two columns, and nothing else may touch a landed row. */
  existing?: { web_alert_ack_at: string | null; created_at: string };
};

/** Coerce a value to a Postgres `date` (YYYY-MM-DD) or null — free text from a
 *  website form ("ASAP", "2-3 weeks", "") would otherwise break the column. */
export function toDateOrNull(s?: string | null): string | null {
  if (!s) return null;
  const m = s.trim().match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : null;
}

/** Coerce to a valid ISO timestamp or null. */
export function toTimestampOrNull(s?: string | null): string | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : s;
}

/**
 * Insert the lead, or return the one that is already there.
 *
 * Never rewrites a landed row. A website submission is immutable once made, so
 * re-applying it could only re-assert the original payload — which is exactly
 * what silently reverted every office correction (name, phone, email,
 * postcodes) on each dashboard load until 2026-08-14. After landing, the panel
 * is the system of record.
 */
export async function landWebsiteLead(
  sb: Sb,
  input: WebsiteLeadInput,
  now: Date,
): Promise<LandedWebsiteLead> {
  const alertSubmittedAt = toTimestampOrNull(input.submittedAt);

  const findExisting = async (): Promise<LandedWebsiteLead | null> => {
    // Ordered: the site's own id first, because it is the one key both
    // delivery routes carry. Separate `.eq` reads rather than a combined
    // `.or()` — an id is opaque text and a comma in it would break PostgREST's
    // filter grammar, turning a dedupe check into a silent miss.
    //
    // The external_lead_id read is scoped to THIS brand, matching the unique
    // index (0106): each brand's site mints its own ids, and two sites will
    // both mint "1234" eventually. Matched on id alone, the second brand's
    // customer reads as a duplicate of the first — adopted, answered 200, and
    // never seen again. sanity_id stays global on purpose: Sanity mints
    // globally-unique document ids and only Marley's pull rail carries one,
    // so there is no second id space to collide with.
    for (const [column, value, brandScoped] of [
      ["external_lead_id", input.externalLeadId, true],
      ["sanity_id", input.sanityId, false],
    ] as const) {
      if (!value) continue;
      let query = sb
        .from("leads")
        .select("id, web_alert_ack_at, created_at")
        .eq(column, value);
      if (brandScoped) query = query.eq("brand", input.brand);
      const { data, error } = await query.maybeSingle();
      // A failed read is not evidence that the lead is absent. Inserting on it
      // would duplicate a customer who is already in the panel, so throw and
      // let the caller retry.
      if (error) throw error;
      if (data) {
        return {
          leadId: data.id,
          created: false,
          alertSubmittedAt,
          existing: { web_alert_ack_at: data.web_alert_ack_at, created_at: data.created_at },
        };
      }
    }
    return null;
  };

  const found = await findExisting();
  if (found) return found;

  const { clientId } = await attachOrCreateClient(sb, {
    name: input.name,
    phone: input.phone,
    email: input.email,
    postcode: input.fromPostcode,
  });

  const a = input.attribution ?? {};
  const { data: created, error } = await sb
    .from("leads")
    .insert({
      client_id: clientId,
      brand: input.brand,
      entry_channel: "web",
      source_system: "website",
      external_lead_id: input.externalLeadId ?? null,
      sanity_id: input.sanityId ?? null,
      // Website visitors type freely ("paul betty", "bh218nb") — normalise on
      // ingest so the panel never shows the raw casing.
      name: formatPersonNameOrNull(input.name),
      phone: input.phone ?? null,
      email: input.email ?? null,
      from_postcode: formatUkPostcodeOrNull(input.fromPostcode),
      to_postcode: formatUkPostcodeOrNull(input.toPostcode),
      property_size: input.propertySize ?? null,
      preferred_date: toDateOrNull(input.preferredDate),
      services: Array.isArray(input.services) ? input.services : [],
      notes: input.notes ?? null,
      source_form: input.sourceForm ?? null,
      referrer_answer: input.referrerAnswer ?? null,
      campaign: a.campaign ?? null,
      variant_key: a.variantKey ?? null,
      landing_url: a.landingUrl ?? null,
      landing_referrer: a.landingReferrer ?? null,
      utm_source: a.utmSource ?? null,
      utm_medium: a.utmMedium ?? null,
      utm_campaign: a.utmCampaign ?? null,
      utm_content: a.utmContent ?? null,
      utm_term: a.utmTerm ?? null,
      utm_id: a.utmId ?? null,
      gclid: a.gclid ?? null,
      gbraid: a.gbraid ?? null,
      wbraid: a.wbraid ?? null,
      fbclid: a.fbclid ?? null,
      msclkid: a.msclkid ?? null,
      ttclid: a.ttclid ?? null,
      li_fat_id: a.liFatId ?? null,
      posthog_distinct_id: a.posthogDistinctId ?? null,
      status: input.status ?? "website_enquiry",
      // A historical import must not surface as a new desktop alarm. Only a
      // genuinely fresh enquiry starts unacknowledged.
      web_alert_ack_at: isFreshEnquiryTimestamp(alertSubmittedAt, now) ? null : now.toISOString(),
      ...(alertSubmittedAt ? { submitted_at: alertSubmittedAt } : {}),
    })
    .select("id")
    .single();

  if (error) {
    // Lost a race with a concurrent delivery of the same submission on one of
    // the partial unique indexes (leads_external_lead_brand_uq / leads_sanity_uq).
    // The winner is the same enquiry, so adopt it: a retry that arrives while
    // the first attempt is still committing must read as success, never as a
    // duplicate customer and never as an error the caller would retry again.
    if ((error as { code?: string }).code === "23505") {
      const raced = await findExisting();
      if (raced) return raced;
    }
    throw error;
  }

  return { leadId: created.id, created: true, alertSubmittedAt };
}
