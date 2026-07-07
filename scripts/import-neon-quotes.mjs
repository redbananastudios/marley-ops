/**
 * Backfill: import the live MM Quotes tool's history (Neon Postgres) into the
 * panel's quotes table. Idempotent by quote_ref — re-running skips existing.
 * The old tool's state_blob is compatible: the wizard runs every loaded blob
 * through normalizeQuoteValues(), which migrates legacy shapes on open.
 *
 * Usage:
 *   NEON_DATABASE_URL=postgres://... node --env-file=.env.production scripts/import-neon-quotes.mjs
 *   (NEON_DATABASE_URL = the marley-quotes Vercel project's DATABASE_URL)
 */
import { neon } from "@neondatabase/serverless";
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const neonUrl = process.env.NEON_DATABASE_URL;
if (!url || !serviceKey || !neonUrl) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / NEON_DATABASE_URL");
  process.exit(1);
}

const sql = neon(neonUrl);
const sb = createClient(url, serviceKey, { auth: { persistSession: false } });

const rows = await sql`
  select quote_ref, estimator, customer_name, customer_email, customer_phone,
         collect_addr, dest_addr, moving_date, moving_date_estimated,
         subtotal, discount, vat_enabled, vat_amount, grand_total, total_miles,
         email_sent, email_sent_at, state_blob, created_at
  from quotes order by created_at asc`;
console.log(`Neon: ${rows.length} quotes found`);

// Map the old tool's estimator names to panel profiles (fallback: unassigned).
const { data: profiles } = await sb.from("profiles").select("id, full_name");
const estimatorId = (name) =>
  (profiles ?? []).find((p) => p.full_name.toLowerCase().startsWith(String(name ?? "").toLowerCase().slice(0, 4)))?.id ?? null;

let imported = 0;
let skipped = 0;
for (const r of rows) {
  const { data: existing } = await sb.from("quotes").select("id").eq("quote_ref", r.quote_ref).maybeSingle();
  if (existing) {
    skipped++;
    continue;
  }
  const { error } = await sb.from("quotes").insert({
    quote_ref: r.quote_ref,
    estimator_id: estimatorId(r.estimator),
    status: r.email_sent ? "sent" : "draft",
    customer_name: r.customer_name || null,
    customer_email: r.customer_email || null,
    customer_phone: r.customer_phone || null,
    collect_addr: r.collect_addr || null,
    dest_addr: r.dest_addr || null,
    moving_date: r.moving_date || null,
    moving_date_estimated: !!r.moving_date_estimated,
    subtotal: r.subtotal,
    discount: r.discount ?? 0,
    vat_enabled: !!r.vat_enabled,
    vat_amount: r.vat_amount ?? 0,
    grand_total: r.grand_total,
    total_miles: r.total_miles,
    email_send_count: r.email_sent ? 1 : 0,
    state_blob: r.state_blob ?? {},
    created_at: r.created_at,
  });
  if (error) {
    console.error(`  ${r.quote_ref}: FAILED — ${error.message}`);
    process.exit(1);
  }
  imported++;
  console.log(`  imported ${r.quote_ref} (${r.customer_name ?? "no name"})`);
}
console.log(`done — ${imported} imported, ${skipped} already present`);
