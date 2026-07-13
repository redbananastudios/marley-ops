/**
 * DATA RESET — wipes all business data but KEEPS users/roles, business settings
 * (rates, pricing, deposit, base location), fleet + staff config, storage
 * sites/units, the automation log (cron_runs) and growth_artifacts.
 * For clearing test data before a backfill.
 *
 * Guarded: refuses without RESET_CONFIRM=yes. Prints the target and row counts.
 *
 * Usage:
 *   RESET_CONFIRM=yes node --env-file=.env.production scripts/reset-data.mjs
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
if (process.env.RESET_CONFIRM !== "yes") {
  console.error(`REFUSING to reset ${url} — set RESET_CONFIRM=yes if you really mean it.`);
  process.exit(1);
}

const sb = createClient(url, serviceKey, { auth: { persistSession: false } });

// FK-safe order (children first). Kept deliberately: profiles, business_settings,
// staff, vehicles, storage_sites, storage_units, cron_runs, growth_artifacts.
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
  // job execution artefacts
  "job_notes",
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
  // storage billing (lets reference clients; sites/units are config and stay)
  "storage_invoices",
  "storage_lets",
  // core
  "quotes",
  "leads",
  "clients",
  "events_log",
];

console.log(`Resetting data on ${url}\n`);
for (const entry of TABLES) {
  const { name, key } = typeof entry === "string" ? { name: entry, key: "id" } : entry;
  const { count } = await sb.from(name).select("*", { count: "exact", head: true });
  // Delete-all via a never-null PK filter (service role bypasses RLS).
  const { error } = await sb.from(name).delete().not(key, "is", null);
  if (error) {
    console.error(`  ${name}: FAILED — ${error.message}`);
    process.exit(1);
  }
  console.log(`  ${name}: ${count ?? 0} rows deleted`);
}

// Empty the media buckets (survey photos + AI survey videos/frames).
for (const bucket of ["survey-photos", "survey-media"]) {
  let removed = 0;
  async function emptyPrefix(prefix) {
    const { data: entries } = await sb.storage.from(bucket).list(prefix, { limit: 1000 });
    for (const e of entries ?? []) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.id) {
        await sb.storage.from(bucket).remove([path]);
        removed++;
      } else {
        await emptyPrefix(path); // folder
      }
    }
  }
  await emptyPrefix("");
  console.log(`  ${bucket} bucket: ${removed} objects removed`);
}

console.log("\nReset complete. Users, settings, staff/fleet, storage sites/units, cron_runs and growth_artifacts kept.");
