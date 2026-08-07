/**
 * Backfill removal appointments for confirmed jobs that never reached the diary.
 *
 * Until 2026-08-07 nothing created the removal appointment automatically (see
 * lib/schedule/ensure-removal-appointment.ts). The code fix only covers deposits
 * landing from now on, so jobs confirmed BEFORE it shipped still have no diary
 * row — and therefore no crew sheet, no completion, no balance alarm.
 *
 * DANGER — read before running with --commit on production:
 *   Inserting a PAST-dated removal makes the post-move sweep in
 *   app/api/cron/chase/route.ts pick the job up on its next run. For a fully
 *   paid job that means auto-complete + a REVIEW REQUEST EMAIL to a real
 *   customer, possibly weeks after their move. For an unpaid one it means a
 *   money ops alert. Both are correct behaviour but they are a surprise, and
 *   the crew-sheet cron may also dispatch a day sheet for a job happening
 *   today or tomorrow.
 *   Past-dated rows therefore require the explicit --include-past flag.
 *   --future-only (the safe default shape) backfills just the jobs still ahead.
 *
 * Usage:
 *   node --env-file=.env.staging scripts/backfill-removal-appointments.mjs            # dry run, everything
 *   node --env-file=.env.staging scripts/backfill-removal-appointments.mjs --future-only --commit
 *   node --env-file=.env.staging scripts/backfill-removal-appointments.mjs --include-past --commit
 */
import { createClient } from "@supabase/supabase-js";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const COMMIT = has("--commit");
const FUTURE_ONLY = has("--future-only");
const INCLUDE_PAST = has("--include-past");
const ALLOW_PROD = has("--prod");

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}
// Hosted *.supabase.co is the staging project; anything else is treated as prod.
const looksLikeProd = !/\.supabase\.co/.test(url);
if (looksLikeProd && !ALLOW_PROD) {
  console.error(`REFUSING: ${url} looks like PRODUCTION. Re-run with --prod if that is genuinely intended.`);
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false } });

/** UK wall-clock instant for a yyyy-mm-dd + hour (handles BST/GMT). */
function ukInstant(day, hour) {
  const [y, m, d] = day.split("-").map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d, hour, 0, 0));
  const asUk = new Date(guess.toLocaleString("en-US", { timeZone: "Europe/London" }));
  const asUtc = new Date(guess.toLocaleString("en-US", { timeZone: "UTC" }));
  return new Date(guess.getTime() + (asUtc.getTime() - asUk.getTime()));
}

const todayUk = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });

const { data: leads, error: leadErr } = await sb
  .from("leads")
  .select("id, name, status, client_id, from_address, from_postcode")
  .in("status", ["confirmed", "provisional"]);
if (leadErr) {
  console.error(`leads query failed: ${leadErr.message}`);
  process.exit(1);
}

const leadIds = (leads ?? []).map((l) => l.id);
if (!leadIds.length) {
  console.log("No confirmed/provisional leads.");
  process.exit(0);
}

const { data: appts, error: apptErr } = await sb
  .from("appointments")
  .select("lead_id, status")
  .eq("appt_type", "removal")
  .neq("status", "cancelled")
  .in("lead_id", leadIds);
if (apptErr) {
  console.error(`appointments query failed: ${apptErr.message}`);
  process.exit(1);
}
const hasAppt = new Set((appts ?? []).map((a) => a.lead_id));

const { data: quotes, error: quoteErr } = await sb
  .from("quotes")
  .select("id, lead_id, quote_ref, status, source, moving_date, estimator_id, client_id, customer_name, accepted_at, booking_cancelled_at")
  .eq("status", "accepted")
  .in("lead_id", leadIds);
if (quoteErr) {
  console.error(`quotes query failed: ${quoteErr.message}`);
  process.exit(1);
}

// Most recently accepted live quote per lead — the same rule /bookings uses.
const current = new Map();
for (const q of quotes ?? []) {
  if (q.booking_cancelled_at) continue;
  const held = current.get(q.lead_id);
  if (!held || (q.accepted_at ?? "").localeCompare(held.accepted_at ?? "") > 0) current.set(q.lead_id, q);
}

const plan = [];
const skipped = [];
for (const lead of leads ?? []) {
  if (hasAppt.has(lead.id)) continue;
  const q = current.get(lead.id);
  if (!q) { skipped.push({ lead, why: "no live accepted quote" }); continue; }
  if (q.source === "imve") { skipped.push({ lead, why: "legacy iMVE (importer owns its diary row)" }); continue; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(q.moving_date ?? "")) { skipped.push({ lead, why: "no move date on the quote" }); continue; }
  plan.push({ lead, quote: q, past: q.moving_date < todayUk });
}

const past = plan.filter((p) => p.past);
const future = plan.filter((p) => !p.past);
const selected = FUTURE_ONLY ? future : INCLUDE_PAST ? plan : future;

console.log(`Confirmed/provisional leads: ${leads.length}`);
console.log(`Already in the diary:        ${leads.filter((l) => hasAppt.has(l.id)).length}`);
console.log(`Missing a diary row:         ${plan.length}  (${future.length} upcoming, ${past.length} already moved)`);
if (skipped.length) {
  console.log(`\nSkipped (${skipped.length}):`);
  for (const s of skipped) console.log(`  - ${s.lead.name}: ${s.why}`);
}

console.log(`\nWould book ${selected.length}:`);
for (const p of selected) {
  console.log(`  ${p.past ? "[PAST] " : "       "}${p.lead.name.padEnd(20)} ${p.quote.quote_ref} on ${p.quote.moving_date}`);
}

if (!FUTURE_ONLY && !INCLUDE_PAST && past.length) {
  console.log(
    `\n!! ${past.length} job(s) have ALREADY MOVED and are excluded by default.\n` +
      `   Adding them makes the post-move sweep auto-complete the fully-paid ones and\n` +
      `   EMAIL THOSE CUSTOMERS A REVIEW REQUEST, and alert on the unpaid ones.\n` +
      `   Pass --include-past only if that is what you want.`,
  );
}

if (!COMMIT) {
  console.log(`\nDRY RUN — nothing written. Add --commit to apply.`);
  process.exit(0);
}

let booked = 0;
for (const p of selected) {
  const { lead, quote } = p;
  const { error } = await sb.from("appointments").insert({
    appt_type: "removal",
    lead_id: lead.id,
    client_id: quote.client_id ?? lead.client_id,
    estimator_id: quote.estimator_id,
    title: `Removal — ${lead.name}`,
    starts_at: ukInstant(quote.moving_date, 8).toISOString(),
    ends_at: ukInstant(quote.moving_date, 17).toISOString(),
    all_day: false,
    location: lead.from_address || lead.from_postcode || null,
    notes: "Backfilled — booking confirmed before the diary auto-book shipped (2026-08-07).",
    status: "scheduled",
  });
  if (error) {
    console.error(`  FAILED ${lead.name} (${quote.quote_ref}): ${error.message}`);
    continue;
  }
  booked++;
  console.log(`  booked ${lead.name} — ${quote.moving_date}`);
}
console.log(`\nDone: ${booked}/${selected.length} booked.`);
