/**
 * SYSTEM FLUSH — wipes ALL business/transactional data (DB + every media object
 * in Supabase Storage AND Cloudflare R2) but KEEPS the identity/config layer:
 * users/roles/passkeys/push devices, business settings (rates, pricing, VAT,
 * deposit, base location), staff + pay rates + working-day patterns, vehicles,
 * storage sites/units, the automation log (cron_runs) and growth_artifacts.
 *
 * This is the go-live "flush down" (Peter, 2026-07-21): full reset, NO backfill —
 * pair it with LEAD_SYNC_SINCE (see lib/sync/sanity-leads.ts) so historical
 * website leads never re-import. Zoho is NEVER touched by this script — it is
 * Connor's live books.
 *
 * Deliberately NOT reset: the next_quote_ref sequences (MMR/MMC counters).
 * Reusing a quote ref would let the Zoho orphan-adoption path (-DEP/-BAL
 * reference matching) adopt a stale test invoice for a new real quote.
 *
 * Guarded: refuses without RESET_CONFIRM=yes. Prints the target and row counts.
 * Dry run: RESET_DRY_RUN=yes counts everything but deletes nothing.
 *
 * Usage:
 *   RESET_DRY_RUN=yes node --env-file=.env.local scripts/reset-data.mjs        # preview
 *   RESET_CONFIRM=yes node --env-file=.env.production scripts/reset-data.mjs   # flush
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const dryRun = process.env.RESET_DRY_RUN === "yes";
if (!dryRun && process.env.RESET_CONFIRM !== "yes") {
  console.error(`REFUSING to flush ${url} — set RESET_CONFIRM=yes (or RESET_DRY_RUN=yes to preview).`);
  process.exit(1);
}

const sb = createClient(url, serviceKey, { auth: { persistSession: false } });

// FK-safe order (children first). Kept deliberately: profiles, business_settings,
// staff, staff_pay, vehicles, storage_sites, storage_units, auth_passkeys,
// push_subscriptions, push_preferences, cron_runs, growth_artifacts.
const TABLES = [
  // AI survey stack (ai_jobs/cubic_* cascade off cubic_surveys, but delete
  // explicitly so counts are visible and no cascade surprises)
  "ai_spend_reservations",
  "ai_jobs",
  "cubic_ai_detections",
  "cubic_analysis_runs",
  "cubic_survey_segments",
  "cubic_survey_media",
  "cubic_survey_rooms",
  "cubic_surveys",
  { name: "ai_spend_months", key: "month" }, // PK is the month date, not id
  // webhooks + operational issues (0070) — composite/date PKs, no id column
  { name: "webhook_delivery_steps", key: "provider" },
  { name: "webhook_receipts", key: "provider" },
  { name: "operational_issue_daily_digests", key: "snapshot_date" },
  "operational_issue_daily_updates",
  "operational_issues",
  // crew job sheets (0068)
  "crew_job_sheet_sends",
  "crew_job_sheets",
  // contractor/estimator invoicing (0056/0064). Agreements wiped too — the
  // reviewed v2 wording re-prompts every contractor at go-live anyway.
  "staff_statement_lines",
  "staff_statements",
  "contractor_agreements",
  // money artefacts
  "refund_queue", // references leads + quotes — before both
  "card_payments", // references quotes — before quotes
  "bank_transactions", // Monzo feed re-imports current sheet rows as unconfirmed
  // availability + reminder ledgers (wiping re-arms fleet reminders — correct at go-live)
  "staff_availability",
  "vehicle_unavailability",
  "vehicle_reminder_log",
  // transient auth artefacts (auth_passkeys themselves are KEPT — real devices)
  "auth_passkey_challenges",
  "auth_passkey_attempts",
  // job execution artefacts
  "job_notes",
  "job_media",
  "claims", // references job_completions -> delete before it
  "job_completions",
  "signatures",
  "appointment_assignments",
  "estimator_payouts",
  // pipeline (appointments reference surveys, so they go first)
  "follow_ups",
  "survey_photos",
  "appointments",
  "surveys",
  "communications",
  "activities",
  // storage billing (lets reference clients; sites/units are config and stay).
  // Handling events RESTRICT their let, so they go before invoices/lets.
  "storage_handling_events",
  "storage_invoices",
  "storage_lets",
  // core
  "quotes",
  "leads",
  "clients",
  "events_log",
];

console.log(`${dryRun ? "DRY RUN — counting only, deleting nothing on" : "Flushing data on"} ${url}\n`);
for (const entry of TABLES) {
  const { name, key } = typeof entry === "string" ? { name: entry, key: "id" } : entry;
  const { count, error: countError } = await sb.from(name).select("*", { count: "exact", head: true });
  if (countError) {
    console.error(`  ${name}: COUNT FAILED — ${countError.message} (missing migration on this env?)`);
    process.exit(1);
  }
  if (dryRun) {
    console.log(`  ${name}: ${count ?? 0} rows would be deleted`);
    continue;
  }
  // Delete-all via a never-null PK filter (service role bypasses RLS).
  const { error } = await sb.from(name).delete().not(key, "is", null);
  if (error) {
    console.error(`  ${name}: FAILED — ${error.message}`);
    process.exit(1);
  }
  console.log(`  ${name}: ${count ?? 0} rows deleted`);
}

// All logical media buckets. Objects may live in Supabase Storage (pre-R2-
// cutover) AND/OR Cloudflare R2 (post-cutover, where each logical bucket is a
// key prefix inside the one R2 bucket) — clear BOTH so a flush leaves nothing.
const MEDIA_BUCKETS = ["survey-photos", "survey-media", "job-media", "job-photos", "job-docs"];

// 1) Supabase Storage (lingering pre-cutover objects).
for (const bucket of MEDIA_BUCKETS) {
  let removed = 0;
  async function emptyPrefix(prefix) {
    const { data: entries } = await sb.storage.from(bucket).list(prefix, { limit: 1000 });
    for (const e of entries ?? []) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.id) {
        if (!dryRun) await sb.storage.from(bucket).remove([path]);
        removed++;
      } else {
        await emptyPrefix(path); // folder
      }
    }
  }
  await emptyPrefix("");
  console.log(`  supabase ${bucket}: ${removed} objects ${dryRun ? "would be " : ""}removed`);
}

// 2) Cloudflare R2 (the live object store post-cutover). Clear each logical
// bucket's key prefix. Skipped cleanly if R2 isn't configured in this env.
if (process.env.MARLEY_R2_ENDPOINT && process.env.MARLEY_R2_BUCKET && process.env.MARLEY_R2_ACCESS_KEY_ID) {
  const { S3Client, ListObjectsV2Command, DeleteObjectsCommand } = await import("@aws-sdk/client-s3");
  const s3 = new S3Client({
    region: "auto",
    endpoint: process.env.MARLEY_R2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.MARLEY_R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.MARLEY_R2_SECRET_ACCESS_KEY,
    },
  });
  const r2Bucket = process.env.MARLEY_R2_BUCKET;
  for (const prefix of MEDIA_BUCKETS) {
    let removed = 0;
    let token;
    do {
      const listed = await s3.send(
        new ListObjectsV2Command({ Bucket: r2Bucket, Prefix: `${prefix}/`, ContinuationToken: token }),
      );
      const objects = (listed.Contents ?? []).map((o) => ({ Key: o.Key }));
      if (objects.length && !dryRun) {
        await s3.send(new DeleteObjectsCommand({ Bucket: r2Bucket, Delete: { Objects: objects, Quiet: true } }));
      }
      removed += objects.length;
      token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (token);
    console.log(`  R2 ${prefix}/: ${removed} objects ${dryRun ? "would be " : ""}removed`);
  }
} else {
  console.log("  R2: not configured (MARLEY_R2_* absent) — skipped");
}

console.log(
  dryRun
    ? "\nDry run complete. Nothing was deleted."
    : "\nFlush complete. Kept: users/passkeys/push devices, settings, staff + pay, vehicles, storage sites/units, cron_runs, growth_artifacts. Quote-ref counters NOT reset (Zoho ref-adoption safety). Zoho untouched.\nRemember: set LEAD_SYNC_SINCE before removing SANITY_SYNC_DISABLED so history never re-imports.",
);
