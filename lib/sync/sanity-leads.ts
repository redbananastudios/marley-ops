import { createAdminClient } from "@/lib/supabase/admin";
import { isImportedUnackedRow } from "@/lib/lead-alerts";
import { applySyncFloor, resolveLeadFloor } from "@/lib/sync/sync-window";
import { landWebsiteLead, toTimestampOrNull } from "@/lib/leads/website-lead";
import { decideEnquiryPushes, isFreshEnquiryTimestamp } from "@/lib/push/categories";
import { sendPushForEvent } from "@/lib/push/send";
import { log } from "@/lib/log";
import type { Database } from "@/lib/supabase/database.types";

type LeadStatus = Database["public"]["Enums"]["lead_status"];

/** Raw shape pulled back from the Sanity query API. */
interface SanityQuote {
  _id: string;
  _createdAt?: string | null;
  /** The id the SITE minted for the submission — the same one the direct
   *  ingest route keys on. Reading it here is what stops one enquiry landing
   *  twice while both delivery routes are live. Absent on documents written
   *  before the site started stamping it. */
  leadId?: string | null;
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
  referrer?: string | null;
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

const FIELDS = `_id, _createdAt, leadId, name, phone, email, fromPostcode, toPostcode, propertySize, preferredDate, services, notes, submittedAt, status, source, referrer, campaign, variantKey, landingUrl, utmSource, utmMedium, utmCampaign, utmContent, utmTerm, "gclid":gclid, "gbraid":gbraid, "wbraid":wbraid, "fbclid":fbclid, "msclkid":msclkid`;

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
      // Freshness anchor: fall back to the Sanity document's own creation time
      // when submittedAt is missing or garbled — a genuinely new enquiry must
      // never be silently skipped by the alert.
      const alertSubmittedAt = toTimestampOrNull(doc.submittedAt) ?? toTimestampOrNull(doc._createdAt);

      // Shared with the direct ingest route (lib/leads/website-lead.ts) so the
      // two delivery routes cannot produce different rows. Passing the site's
      // own leadId as well as the document id is what makes running both at
      // once safe: whichever delivery arrives second finds the first one's row.
      const landed = await landWebsiteLead(
        admin,
        {
          // The pull rail is Marley's website only — the brand is stamped
          // explicitly, never inferred (multi-brand PRD §10).
          brand: "marley",
          externalLeadId: doc.leadId ?? null,
          sanityId: doc._id,
          name: doc.name,
          phone: doc.phone,
          email: doc.email,
          fromPostcode: doc.fromPostcode,
          toPostcode: doc.toPostcode,
          propertySize: doc.propertySize,
          preferredDate: doc.preferredDate,
          services: doc.services,
          notes: doc.notes,
          sourceForm: doc.source,
          referrerAnswer: doc.referrer,
          submittedAt: alertSubmittedAt,
          status: mapStatus(doc.status),
          attribution: {
            campaign: doc.campaign,
            variantKey: doc.variantKey,
            landingUrl: doc.landingUrl,
            utmSource: doc.utmSource,
            utmMedium: doc.utmMedium,
            utmCampaign: doc.utmCampaign,
            utmContent: doc.utmContent,
            utmTerm: doc.utmTerm,
            gclid: doc.gclid,
            gbraid: doc.gbraid,
            wbraid: doc.wbraid,
            fbclid: doc.fbclid,
            msclkid: doc.msclkid,
          },
        },
        syncNow,
      );

      if (landed.created) {
        inserted += 1;
        insertedLeads.push({ id: landed.leadId, name: doc.name ?? null, submittedAt: alertSubmittedAt });
      } else if (landed.existing) {
        // An already-landed lead is NEVER re-written from the site payload (see
        // landWebsiteLead). The only touch an existing row gets is the one-shot
        // alarm repair for historical imports (migration 0071's guard) — a
        // genuinely fresh lead has created_at ≈ submitted_at and stays
        // unacknowledged until a human acks it.
        if (
          landed.existing.web_alert_ack_at === null &&
          !isFreshEnquiryTimestamp(alertSubmittedAt, syncNow) &&
          isImportedUnackedRow(landed.existing.created_at, alertSubmittedAt)
        ) {
          const { error } = await admin
            .from("leads")
            .update({ web_alert_ack_at: syncNow.toISOString() })
            .eq("id", landed.leadId);
          if (error) throw error;
          updated += 1;
        }
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
