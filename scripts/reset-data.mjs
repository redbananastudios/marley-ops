/**
 * DATA RESET — wipes all business data but KEEPS users/roles and business settings
 * (rates, pricing, deposit, base location). For clearing test data before backfill.
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

// FK-safe order (children first). profiles + business_settings deliberately kept.
const TABLES = [
  "follow_ups",
  "survey_photos",
  "surveys",
  "communications",
  "activities",
  "appointments",
  "quotes",
  "leads",
  "clients",
  "events_log",
];

console.log(`Resetting data on ${url}\n`);
for (const t of TABLES) {
  const { count } = await sb.from(t).select("*", { count: "exact", head: true });
  // Delete-all via a never-null column filter (service role bypasses RLS).
  const { error } = await sb.from(t).delete().not("id", "is", null);
  if (error) {
    console.error(`  ${t}: FAILED — ${error.message}`);
    process.exit(1);
  }
  console.log(`  ${t}: ${count ?? 0} rows deleted`);
}

// Empty the survey-photos bucket.
let removed = 0;
async function emptyPrefix(prefix) {
  const { data: entries } = await sb.storage.from("survey-photos").list(prefix, { limit: 1000 });
  for (const e of entries ?? []) {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.id) {
      await sb.storage.from("survey-photos").remove([path]);
      removed++;
    } else {
      await emptyPrefix(path); // folder
    }
  }
}
await emptyPrefix("");
console.log(`  survey-photos bucket: ${removed} objects removed`);

console.log("\nReset complete. Users, roles and business settings kept.");
console.log("Backfill: (1) full Sanity sync from the Leads page, (2) node scripts/import-neon-quotes.mjs");
