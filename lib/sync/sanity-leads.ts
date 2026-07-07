import { createAdminClient } from "@/lib/supabase/admin";
import { attachOrCreateClient } from "@/lib/leads/resolver";
import type { Database } from "@/lib/supabase/database.types";

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

const FIELDS = `_id, name, phone, email, fromPostcode, toPostcode, propertySize, preferredDate, services, notes, submittedAt, status, source, campaign, variantKey, landingUrl, utmSource, utmMedium, utmCampaign, utmContent, utmTerm, "gclid":gclid, "gbraid":gbraid, "wbraid":wbraid, "fbclid":fbclid, "msclkid":msclkid`;

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

export interface SyncResult {
  ok: boolean;
  synced: number;
  inserted: number;
  updated: number;
  failed: number;
  firstError?: string;
  error?: string;
}

/**
 * Pull website leads from Sanity into Supabase. Idempotent on `sanity_id`.
 * Status precedence: a panel-changed status is never overwritten (set only on insert).
 *
 * Modes:
 *   - full (default)     : every quoteSubmission (the manual "Sync leads" button).
 *   - incremental: true  : only docs newer than the latest already-synced lead
 *                          (minus a 2-day overlap to catch late edits) — fast, for
 *                          the on-dashboard-load auto-sync.
 */
export async function syncSanityLeads(opts: { since?: string; incremental?: boolean } = {}): Promise<SyncResult> {
  // Kill switch: while comms testing runs against seeded test leads, the sync must
  // not re-import real website leads (it fires on dashboard/leads load + daily cron).
  if (process.env.SANITY_SYNC_DISABLED === "true") {
    return { ok: false, synced: 0, inserted: 0, updated: 0, failed: 0, error: "Sanity sync disabled (SANITY_SYNC_DISABLED=true)" };
  }
  const projectId = process.env.SANITY_PROJECT_ID || "963i5lvk";
  const dataset = process.env.SANITY_DATASET || "production";
  const token = process.env.SANITY_API_READ_TOKEN;
  if (!token) return { ok: false, synced: 0, inserted: 0, updated: 0, failed: 0, error: "Sanity read token not configured" };

  const admin = createAdminClient();

  // Resolve the incremental cutoff: latest synced submitted_at, minus a 2-day overlap.
  let since = opts.since;
  if (!since && opts.incremental) {
    const { data: latest } = await admin
      .from("leads")
      .select("submitted_at")
      .eq("source_system", "website")
      .not("submitted_at", "is", null)
      .order("submitted_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latest?.submitted_at) {
      since = new Date(new Date(latest.submitted_at).getTime() - 2 * 86_400_000).toISOString();
    }
  }

  const filter = since ? ` && submittedAt >= "${since}"` : "";
  const groq = `*[_type=="quoteSubmission"${filter}]| order(submittedAt asc){ ${FIELDS} }`;
  const url = `https://${projectId}.api.sanity.io/v2021-10-21/data/query/${dataset}?query=${encodeURIComponent(groq)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, synced: 0, inserted: 0, updated: 0, failed: 0, error: err instanceof Error ? err.message : "Sanity fetch failed" };
  }
  clearTimeout(timer);

  if (res.status === 401) {
    return { ok: false, synced: 0, inserted: 0, updated: 0, failed: 0, error: "Sanity read token rejected (401)" };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { ok: false, synced: 0, inserted: 0, updated: 0, failed: 0, error: `Sanity query failed (${res.status})${body ? `: ${body}` : ""}` };
  }

  const json = (await res.json()) as { result?: SanityQuote[] };
  const docs = json.result ?? [];

  let inserted = 0;
  let updated = 0;
  let failed = 0;
  let firstError: string | undefined;

  for (const doc of docs) {
    // One bad doc must not abort the batch — isolate each.
    try {
      const { clientId } = await attachOrCreateClient(admin, {
        name: doc.name,
        phone: doc.phone,
        email: doc.email,
        postcode: doc.fromPostcode,
      });

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
        const { error } = await admin.from("leads").insert({ ...baseFields, status: mapStatus(doc.status) });
        if (error) throw error;
        inserted += 1;
      }
    } catch (docErr) {
      failed += 1;
      if (!firstError) firstError = docErr instanceof Error ? docErr.message : String(docErr);
    }
  }

  return { ok: true, synced: inserted + updated, inserted, updated, failed, ...(firstError ? { firstError } : {}) };
}
