import { createAdminClient } from "@/lib/supabase/admin";
import { attachOrCreateClient } from "@/lib/leads/resolver";
import { formatPersonNameOrNull, formatUkPostcodeOrNull } from "@/lib/leads/format";
import { isImportedUnackedRow } from "@/lib/lead-alerts";
import { applySyncFloor, resolveLeadFloor } from "@/lib/sync/sync-window";
import { decideEnquiryPushes, isFreshEnquiryTimestamp } from "@/lib/push/categories";
import { sendPushForEvent } from "@/lib/push/send";
import { log } from "@/lib/log";
import type { Database } from "@/lib/supabase/database.types";

type LeadStatus = Database["public"]["Enums"]["lead_status"];

/** Raw shape pulled back from the Sanity query API. */
interface SanityQuote {
  _id: string;
  _createdAt?: string | null;
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

const FIELDS = `_id, _createdAt, name, phone, email, fromPostcode, toPostcode, propertySize, preferredDate, services, notes, submittedAt, status, source, campaign, variantKey, landingUrl, utmSource, utmMedium, utmCampaign, utmContent, utmTerm, "gclid":gclid, "gbraid":gbraid, "wbraid":wbraid, "fbclid":fbclid, "msclkid":msclkid`;

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
  // Hard go-live floor — history before LEAD_SYNC_SINCE never imports, even in
  // full mode with an empty (freshly-flushed) database. See lib/sync/sync-window.ts.
  //
  // FAIL CLOSED: if the floor can't be resolved (LEAD_SYNC_SINCE unset, empty or
  // garbled) AND we have no incremental cutoff (`since` still undefined — a full
  // sync, or an incremental run against a freshly-flushed empty leads table with
  // no latest row), the GROQ filter would be empty and re-import EVERY pre-go-live
  // submission. Refuse instead of importing unfloored. Incremental runs that DID
  // resolve a cutoff are unaffected — their own lower bound protects them, so the
  // floor legitimately stays fail-open there (reviewer, 2026-07-31).
  const leadFloor = resolveLeadFloor(process.env.LEAD_SYNC_SINCE);
  if (!leadFloor && !since) {
    log.warn("sanity-leads.floor_unresolved", { raw: process.env.LEAD_SYNC_SINCE ?? null });
    return { ok: false, synced: 0, inserted: 0, updated: 0, failed: 0, error: "LEAD_SYNC_SINCE floor unresolved" };
  }
  since = applySyncFloor(since, process.env.LEAD_SYNC_SINCE);

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
  const insertedLeads: { id: string; name: string | null; submittedAt: string | null }[] = [];
  const syncNow = new Date();

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
      const alertSubmittedAt = submittedAt ?? toTimestampOrNull(doc._createdAt);
      const isFreshAlert = isFreshEnquiryTimestamp(alertSubmittedAt, syncNow);
      const baseFields = {
        client_id: clientId,
        entry_channel: "web" as const,
        source_system: "website",
        sanity_id: doc._id,
        // Website visitors type freely ("paul betty", "bh218nb") — normalise
        // on ingest so the panel never shows the raw casing.
        name: formatPersonNameOrNull(doc.name),
        phone: doc.phone ?? null,
        email: doc.email ?? null,
        from_postcode: formatUkPostcodeOrNull(doc.fromPostcode),
        to_postcode: formatUkPostcodeOrNull(doc.toPostcode),
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
        ...(alertSubmittedAt ? { submitted_at: alertSubmittedAt } : {}),
      };

      const { data: existing } = await admin
        .from("leads")
        .select("id, web_alert_ack_at, created_at")
        .eq("sanity_id", doc._id)
        .maybeSingle();

      if (existing) {
        // An already-landed lead is NEVER re-written from the site payload. A
        // Sanity quoteSubmission is immutable once submitted, so re-applying
        // baseFields could only re-assert the original submission — which
        // silently reverted every office correction (name, phone, email,
        // postcodes, notes) on the next dashboard load: Stephen Bull's
        // postcode fix was clobbered twice on 2026-08-14 and the Edit-Lead
        // dialog looked broken. After landing, the panel is the system of
        // record. The only touch an existing row gets is the one-shot alarm
        // repair for historical imports (migration 0071's guard) — a
        // genuinely fresh lead has created_at ≈ submitted_at and stays
        // unacknowledged until a human acks it.
        if (
          existing.web_alert_ack_at === null &&
          !isFreshAlert &&
          isImportedUnackedRow(existing.created_at, alertSubmittedAt)
        ) {
          const { error } = await admin
            .from("leads")
            .update({ web_alert_ack_at: syncNow.toISOString() })
            .eq("id", existing.id);
          if (error) throw error;
          updated += 1;
        }
      } else {
        const { data: created, error } = await admin
          .from("leads")
          .insert({
            ...baseFields,
            status: mapStatus(doc.status),
            // Historical imports must not surface as new desktop alarms. Only
            // genuinely fresh inserts start unacknowledged.
            web_alert_ack_at: isFreshAlert ? null : syncNow.toISOString(),
          })
          .select("id")
          .single();
        if (error) throw error;
        inserted += 1;
        // Freshness for the push decision: fall back to the Sanity document's
        // own creation time when submittedAt is missing/garbled — a genuinely
        // new enquiry must never be silently skipped by the alert.
        insertedLeads.push({
          id: created.id,
          name: doc.name ?? null,
          submittedAt: alertSubmittedAt,
        });
      }
    } catch (docErr) {
      failed += 1;
      if (!firstError) firstError = docErr instanceof Error ? docErr.message : String(docErr);
    }
  }

  // Office push for freshly-landed enquiries (best-effort — sendPushForEvent
  // never throws). The freshness window + digest rule keep the cutover
  // backfill (months of history in one run) completely silent.
  for (const event of decideEnquiryPushes(insertedLeads, syncNow)) {
    await sendPushForEvent(event);
  }

  return { ok: true, synced: inserted + updated, inserted, updated, failed, ...(firstError ? { firstError } : {}) };
}
