import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { attachOrCreateClient } from "@/lib/leads/resolver";
import type { Database } from "@/lib/supabase/database.types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type LeadStatus = Database["public"]["Enums"]["lead_status"];

/** Raw shape pulled back from the Sanity query API. */
interface SanityQuote {
  _id: string;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  fromPostcode?: string | null;
  toPostcode?: string | null;
  propertySize?: string | null;
  preferredDate?: string | null;
  services?: string[] | null;
  notes?: string | null;
  submittedAt?: string | null;
  status?: string | null;
  source?: string | null;
  campaign?: string | null;
  variantKey?: string | null;
  landingUrl?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  utmContent?: string | null;
  utmTerm?: string | null;
  gclid?: string | null;
  gbraid?: string | null;
  wbraid?: string | null;
  fbclid?: string | null;
  msclkid?: string | null;
}

const GROQ = `*[_type=="quoteSubmission"]| order(submittedAt asc){ _id, name, phone, email, fromPostcode, toPostcode, propertySize, preferredDate, services, notes, submittedAt, status, source, campaign, variantKey, landingUrl, utmSource, utmMedium, utmCampaign, utmContent, utmTerm, "gclid":gclid, "gbraid":gbraid, "wbraid":wbraid, "fbclid":fbclid, "msclkid":msclkid }`;

/** Coerce a Sanity value to a Postgres `date` (YYYY-MM-DD) or null — Sanity free-text
 *  ("ASAP", "2-3 weeks", "") would otherwise break the date column. */
function toDateOrNull(s?: string | null): string | null {
  if (!s) return null;
  const t = s.trim();
  const m = t.match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : null;
}

/** Coerce to a valid ISO timestamp or null. */
function toTimestampOrNull(s?: string | null): string | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : s;
}

/** Map a Sanity submission status onto our funnel enum. Only applied on INSERT. */
function mapStatus(raw?: string | null): LeadStatus {
  switch ((raw ?? "").toLowerCase()) {
    case "quoted":
      return "quoted";
    case "won":
      return "confirmed";
    case "lost":
      return "declined";
    case "new":
    case "contacted":
    default:
      return "website_enquiry";
  }
}

async function syncSanityLeads() {
  const projectId = process.env.SANITY_PROJECT_ID || "963i5lvk";
  const dataset = process.env.SANITY_DATASET || "production";
  const token = process.env.SANITY_API_READ_TOKEN;

  const url = `https://${projectId}.api.sanity.io/v2021-10-21/data/query/${dataset}?query=${encodeURIComponent(
    GROQ,
  )}`;

  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url, { headers, cache: "no-store" });

  if (res.status === 401) {
    return NextResponse.json(
      { ok: false, error: "Sanity read token not configured" },
      { status: 200 },
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return NextResponse.json(
      { ok: false, error: `Sanity query failed (${res.status})${body ? `: ${body}` : ""}` },
      { status: 200 },
    );
  }

  const json = (await res.json()) as { result?: SanityQuote[] };
  const docs = json.result ?? [];

  const admin = createAdminClient();
  let inserted = 0;
  let updated = 0;
  let failed = 0;
  let firstError: string | null = null;

  for (const doc of docs) {
    // One bad doc must not abort the batch — isolate each.
    try {
      const { clientId } = await attachOrCreateClient(admin, {
        name: doc.name,
        phone: doc.phone,
        email: doc.email,
        postcode: doc.fromPostcode,
      });

      // Non-status fields shared by insert + update. Status precedence:
      // never overwrite a panel-changed status — only set it on first insert.
      const submittedAt = toTimestampOrNull(doc.submittedAt);
      const baseFields = {
        client_id: clientId,
        entry_channel: "web" as const,
        source_system: "website",
        sanity_id: doc._id,
        name: doc.name ?? null,
        phone: doc.phone ?? null,
        email: doc.email ?? null,
        from_postcode: doc.fromPostcode ?? null,
        to_postcode: doc.toPostcode ?? null,
        property_size: doc.propertySize ?? null,
        preferred_date: toDateOrNull(doc.preferredDate),
        services: Array.isArray(doc.services) ? doc.services : [],
        notes: doc.notes ?? null,
        campaign: doc.campaign ?? null,
        variant_key: doc.variantKey ?? null,
        landing_url: doc.landingUrl ?? null,
        utm_source: doc.utmSource ?? null,
        utm_medium: doc.utmMedium ?? null,
        utm_campaign: doc.utmCampaign ?? null,
        utm_content: doc.utmContent ?? null,
        utm_term: doc.utmTerm ?? null,
        gclid: doc.gclid ?? null,
        gbraid: doc.gbraid ?? null,
        wbraid: doc.wbraid ?? null,
        fbclid: doc.fbclid ?? null,
        msclkid: doc.msclkid ?? null,
        ...(submittedAt ? { submitted_at: submittedAt } : {}),
      };

      // Does this Sanity doc already exist as a lead?
      const { data: existing } = await admin
        .from("leads")
        .select("id")
        .eq("sanity_id", doc._id)
        .maybeSingle();

      if (existing) {
        // Update only non-status fields — preserve any panel-driven status change.
        const { error } = await admin.from("leads").update(baseFields).eq("id", existing.id);
        if (error) throw error;
        updated += 1;
      } else {
        const { error } = await admin
          .from("leads")
          .insert({ ...baseFields, status: mapStatus(doc.status) });
        if (error) throw error;
        inserted += 1;
      }
    } catch (docErr) {
      failed += 1;
      if (!firstError) firstError = docErr instanceof Error ? docErr.message : String(docErr);
    }
  }

  return NextResponse.json({
    ok: true,
    synced: inserted + updated,
    inserted,
    updated,
    failed,
    ...(firstError ? { firstError } : {}),
  });
}

export async function GET() {
  try {
    return await syncSanityLeads();
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unknown sync error";
    return NextResponse.json({ ok: false, error }, { status: 200 });
  }
}

export async function POST() {
  return GET();
}
