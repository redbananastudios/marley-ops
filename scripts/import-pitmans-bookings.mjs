/**
 * Import Pitmans forward bookings (removals already sold by Mark) into
 * marley-ops from a CSV. Gate 20 of docs/multi-brand-prd.md.
 *
 * These are LIVE bookings sold under Pitmans' own terms, to customers who have
 * never heard from Marley. Every row imports as:
 *   client (matched by email/phone, created if new)
 *   → lead   (status 'confirmed', brand 'pitmans', source_system 'pitmans',
 *             chase_paused, date-confirmed)
 *   → quote  (status 'accepted', source 'pitmans', a FRESH PMR###/PMC### ref,
 *             the original Pitmans reference kept in legacy_ref)
 *   → removal appointment (08:00-17:00 UK on the move date, so /schedule is
 *             ONE diary across both brands)
 *   → an activity note recording the import.
 *
 * WHAT MAKES THIS SAFE. source='pitmans' is in IMPORTED_SOURCES (lib/legacy.ts,
 * migration 0114), so legacyLocked() hard-excludes every imported booking from
 * automated customer email and money automation: no chases, no commitment
 * invoicing, no T-7 final invoice. The office lifts that per booking with the
 * standard-comms switch on the lead page, AFTER phoning the customer. The first
 * contact from a new owner is not an automated payment demand. chase_paused on
 * the lead is belt-and-braces on top.
 *
 * REFERENCES. Unlike the iMVE import, the customer-facing ref is NOT the old
 * system's: it is minted fresh per brand by next_quote_ref(kind, 'pitmans')
 * (migration 0104), so it is unique, collision-free under concurrency, and
 * matchable by the bank feed (gate 6 widened the matcher to PM refs). Mark's
 * original reference is kept verbatim in quotes.legacy_ref for reconciliation
 * against his paperwork. Minting CONSUMES a counter, so it happens only under
 * --commit; the dry run reads the counter and shows the refs it would mint.
 *
 * Usage (DRY RUN is the default - nothing is written until --commit):
 *   node scripts/import-pitmans-bookings.mjs jobs.csv                  # plan only
 *   node scripts/import-pitmans-bookings.mjs jobs.csv --commit         # write (staging)
 *   node scripts/import-pitmans-bookings.mjs jobs.csv --commit --prod  # write (prod needs the extra flag)
 *   node scripts/import-pitmans-bookings.mjs --rollback pitmans-2026-09-21
 *   node scripts/import-pitmans-bookings.mjs --rollback pitmans-2026-09-21 --commit [--prod]
 *
 * Env: NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (same pair as the
 * app). Run with `node --env-file=<envfile>` locally, or via the docker
 * `--env-file /opt/marley-ops[-staging]/app.env` pattern on the VPS.
 *
 * CSV columns (header row required; order free; unknown columns ignored):
 *   pitmans_ref*     Mark's reference for the job (kept verbatim in legacy_ref)
 *   customer_name*
 *   email            phone            (at least one strongly recommended)
 *   is_company       y/n - commercial account. Drives the PMC ref, the
 *                    commercial payment policy (invoice on completion, on the
 *                    client's terms) and the net/VAT/gross presentation
 *   payment_terms_days  30 (default) or 60 - commercial accounts only
 *   po_number        printed on the commercial invoice when present
 *   from_address     from_postcode    to_address        to_postcode
 *   moving_date*     YYYY-MM-DD or DD/MM/YYYY
 *   agreed_price*    number, VAT-INCLUSIVE gross (no £ sign needed; commas fine)
 *   deposit_amount   number, default 0
 *   deposit_paid     y/n - the deposit has been received
 *   deposit_paid_date YYYY-MM-DD or DD/MM/YYYY - REQUIRED when deposit_paid=y
 *                    and the deposit is > 0 (the ledger keys money by date)
 *   deposit_method   bank | card | cash (optional)
 *   balance_paid     y/n - the job is fully settled
 *   balance_paid_date YYYY-MM-DD or DD/MM/YYYY - REQUIRED when balance_paid=y
 *   vehicle          transit | 1luton | 2luton | 3luton | 4luton | 5luton
 *                    (drives crew/van capacity on /schedule; blank = minimum crew)
 *   notes            free text (lands on the lead + the appointment)
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const BRAND = "pitmans";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const commit = flag("--commit");
const prodOk = flag("--prod");
const rollbackIdx = args.indexOf("--rollback");
const rollbackBatch = rollbackIdx >= 0 ? args[rollbackIdx + 1] : null;
const batchIdx = args.indexOf("--batch");
const batch =
  batchIdx >= 0 ? args[batchIdx + 1] : `pitmans-${new Date().toISOString().slice(0, 10)}`;
const csvPath = args.find((a) => !a.startsWith("--") && a !== rollbackBatch && a !== batch);

// Staging is a hosted supabase.co project; a local Supabase is the CLI's own
// 54321. Anything ELSE is the self-hosted prod stack and needs an explicit
// --prod, so a staging habit can't hit prod.
//
// Local is recognised separately rather than lumped in with prod: import-imve
// requires --prod to write to a dev database, which makes the one flag that
// guards production a thing you type routinely. A guard used every day stops
// being read.
const target = new URL(url);
const looksHosted = /\.supabase\.co$/i.test(target.hostname);
const looksLocal =
  target.port === "54321" || ["localhost", "127.0.0.1", "::1"].includes(target.hostname);
if (commit && !looksHosted && !looksLocal && !prodOk) {
  console.error(`Target ${url} is NOT the hosted staging project or a local Supabase — pass --prod if you really mean production.`);
  process.exit(1);
}
const where = looksHosted ? "staging/hosted" : looksLocal ? "LOCAL dev" : "SELF-HOSTED — prod?";
console.log(`target: ${url}  (${where})  mode: ${commit ? "COMMIT" : "dry-run"}`);

const sb = createClient(url, serviceKey, { auth: { persistSession: false } });
const die = (msg) => {
  console.error(`\nFATAL: ${msg}`);
  process.exit(1);
};

/* ------------------------------------------------------------------ helpers */

function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQ = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // strip UTF-8 BOM (Excel exports)
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQ) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); if (row.some((f) => f.trim() !== "")) rows.push(row); }
  return rows;
}

const yes = (v) => /^(y|yes|true|1|paid)$/i.test(String(v ?? "").trim());
const money = (v) => {
  const n = Number(String(v ?? "").replace(/[£,\s]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};
function isoDate(v) {
  const s = String(v ?? "").trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); // UK d/m/Y
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}
/** ISO timestamp for HH:00 UK-local on a date (handles GMT/BST). */
function ukTime(dateStr, hour) {
  const guess = new Date(`${dateStr}T${String(hour).padStart(2, "0")}:00:00Z`);
  const ukHour = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", hour12: false }).format(guess),
  );
  return new Date(guess.getTime() - (ukHour - hour) * 3600_000).toISOString();
}
const normEmail = (v) => String(v ?? "").trim().toLowerCase() || null;
const phoneDigits = (v) => String(v ?? "").replace(/\D/g, "").replace(/^44/, "0");
function normMethod(v) {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return null;
  if (/bank|bacs|transfer/.test(s)) return "bank_transfer";
  if (/card/.test(s)) return "card";
  if (/cash/.test(s)) return "cash";
  return null;
}
const VEHICLES = new Set(["transit", "1luton", "2luton", "3luton", "4luton", "5luton"]);
const TERMS_DAYS = new Set([30, 60]);

/* ----------------------------------------------------------------- rollback */

if (rollbackBatch) {
  const { data: leads, error } = await sb
    .from("leads")
    .select("id, name, client_id")
    .eq("import_batch", rollbackBatch);
  if (error) die(error.message);
  if (!leads?.length) die(`No leads carry import_batch='${rollbackBatch}' — nothing to roll back.`);
  const leadIds = leads.map((l) => l.id);

  const { data: quotes } = await sb.from("quotes").select("id, quote_ref, source").in("lead_id", leadIds);
  const foreign = (quotes ?? []).filter((q) => q.source !== BRAND);
  if (foreign.length) die(`Batch leads carry NON-pitmans quotes (${foreign.map((q) => q.quote_ref).join(", ")}) — refusing.`);
  const quoteIds = (quotes ?? []).map((q) => q.id);

  // Refuse if real work has attached to the batch since import — a rollback
  // must never delete evidence of money or customer contact.
  const blockers = [];
  if (quoteIds.length) {
    const { data: txs } = await sb.from("bank_transactions").select("id").in("matched_quote_id", quoteIds).limit(5);
    if (txs?.length) blockers.push(`${txs.length}+ bank transactions matched to batch quotes`);
    const { data: sigs } = await sb.from("signatures").select("id").in("quote_id", quoteIds).limit(5);
    if (sigs?.length) blockers.push(`${sigs.length}+ signatures on batch quotes`);
  }
  const { data: comms } = await sb.from("communications").select("id").in("lead_id", leadIds).limit(5);
  if (comms?.length) blockers.push(`${comms.length}+ communications on batch leads`);
  // job_completions FK-RESTRICTs its appointment — a crew-completed job would
  // die mid-delete AFTER follow_ups/activities were gone. Refuse upfront.
  const { data: batchAppts } = await sb.from("appointments").select("id").in("lead_id", leadIds);
  const batchApptIds = (batchAppts ?? []).map((a) => a.id);
  if (batchApptIds.length) {
    const { data: completions } = await sb
      .from("job_completions")
      .select("id")
      .in("appointment_id", batchApptIds)
      .limit(5);
    if (completions?.length) blockers.push(`${completions.length}+ crew job-completion sign-offs on batch appointments`);
  }
  if (blockers.length) die(`Refusing rollback — real records exist:\n  - ${blockers.join("\n  - ")}`);

  console.log(`rollback plan for '${rollbackBatch}': ${leads.length} leads, ${quoteIds.length} quotes`);
  for (const l of leads) console.log(`  - ${l.name}`);
  // The minted PMR/PMC refs are NOT returned to the counter. brand_ref_counters
  // only ever moves forward, exactly as scripts/reset-data.mjs leaves it alone:
  // a reissued reference could reach a second customer while the first still
  // holds paperwork quoting it. A rolled-back batch leaves a gap in the
  // sequence, which is the correct trade.
  if (!commit) { console.log("\nDry run — add --commit to delete."); process.exit(0); }

  // FK-safe order; each step is fatal on error so nothing half-deletes silently.
  const del = async (table, col, ids) => {
    if (!ids.length) return;
    const { error: e } = await sb.from(table).delete().in(col, ids);
    if (e) die(`${table}: ${e.message}`);
  };
  await del("follow_ups", "lead_id", leadIds);
  await del("activities", "lead_id", leadIds);
  await del("appointments", "lead_id", leadIds);
  await del("booking_details", "lead_id", leadIds);
  await del("quotes", "id", quoteIds);
  await del("leads", "id", leadIds);
  // Only clients this batch CREATED, and only if no other lead points at them.
  const { data: createdClients } = await sb.from("clients").select("id").eq("import_batch", rollbackBatch);
  for (const c of createdClients ?? []) {
    const { data: otherLeads } = await sb.from("leads").select("id").eq("client_id", c.id).limit(1);
    if (!otherLeads?.length) {
      const { error: cDelErr } = await sb.from("clients").delete().eq("id", c.id);
      if (cDelErr) console.warn(`  warning: client ${c.id} not deleted — ${cDelErr.message}`);
    }
  }
  console.log(`rolled back '${rollbackBatch}'.`);
  process.exit(0);
}

/* ------------------------------------------------------------------- import */

if (!csvPath) die("Usage: node scripts/import-pitmans-bookings.mjs <csv> [--commit] [--prod] [--batch <label>]  |  --rollback <batch>");

// The brand row must exist before anything references it (FK on leads.brand,
// quotes.brand, appointments.brand). It does NOT need to be active: staging
// seeds active=true, prod stays false until the cutover, and importing into an
// inactive brand is exactly what the PRD's activation step expects to find.
const { data: brandRow, error: brandErr } = await sb
  .from("brands")
  .select("slug, name, active")
  .eq("slug", BRAND)
  .maybeSingle();
if (brandErr) die(`brands read failed — ${brandErr.message}`);
if (!brandRow) die(`No '${BRAND}' row in brands — apply migration 0104 and seed the brand before importing.`);
if (!brandRow.active) {
  console.log(`note: brand '${BRAND}' is not active yet — importing anyway (rows render once it is activated).`);
}

const rows = parseCsv(readFileSync(csvPath, "utf8"));
if (rows.length < 2) die("CSV needs a header row + at least one data row.");
const header = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
const col = (row, name) => {
  const i = header.indexOf(name);
  return i >= 0 ? String(row[i] ?? "").trim() : "";
};

const errors = [];
const jobs = rows.slice(1).map((r, idx) => {
  const line = idx + 2;
  const isCompany = yes(col(r, "is_company"));
  const termsRaw = col(r, "payment_terms_days");
  const job = {
    line,
    pitmansRef: col(r, "pitmans_ref"),
    name: col(r, "customer_name"),
    email: normEmail(col(r, "email")),
    phone: col(r, "phone") || null,
    isCompany,
    termsDays: termsRaw ? Number(termsRaw) : null,
    poNumber: col(r, "po_number") || null,
    fromAddress: col(r, "from_address") || null,
    fromPostcode: col(r, "from_postcode") || null,
    toAddress: col(r, "to_address") || null,
    toPostcode: col(r, "to_postcode") || null,
    movingDate: isoDate(col(r, "moving_date")),
    agreed: money(col(r, "agreed_price")),
    deposit: money(col(r, "deposit_amount")) ?? 0,
    depositPaid: yes(col(r, "deposit_paid")),
    depositPaidDate: isoDate(col(r, "deposit_paid_date")),
    depositMethod: normMethod(col(r, "deposit_method")),
    balancePaid: yes(col(r, "balance_paid")),
    balancePaidDate: isoDate(col(r, "balance_paid_date")),
    vehicle: col(r, "vehicle").toLowerCase() || null,
    notes: col(r, "notes") || null,
  };
  if (!job.pitmansRef) errors.push(`line ${line}: pitmans_ref is required`);
  if (!job.name) errors.push(`line ${line}: customer_name is required`);
  if (!job.movingDate) errors.push(`line ${line}: moving_date missing or unreadable (use YYYY-MM-DD or DD/MM/YYYY)`);
  if (job.agreed == null || job.agreed <= 0) errors.push(`line ${line}: agreed_price missing or not a number`);
  // A non-empty cell the parser can't read must ERROR, never silently default —
  // a £100 deposit mistyped as "1O0" would otherwise import as £0 "settled".
  if (col(r, "deposit_amount") && money(col(r, "deposit_amount")) == null)
    errors.push(`line ${line}: deposit_amount '${col(r, "deposit_amount")}' is not a number`);
  if (col(r, "deposit_paid_date") && !job.depositPaidDate)
    errors.push(`line ${line}: deposit_paid_date '${col(r, "deposit_paid_date")}' unreadable (use YYYY-MM-DD or DD/MM/YYYY)`);
  if (col(r, "balance_paid_date") && !job.balancePaidDate)
    errors.push(`line ${line}: balance_paid_date '${col(r, "balance_paid_date")}' unreadable (use YYYY-MM-DD or DD/MM/YYYY)`);
  // HARD errors, not warnings — inherited from the 2026-08-16 iMVE lesson: a
  // paid stamp without its real date pollutes the received ledger the moment it
  // lands (that cost an 18-row prod data fix).
  if (job.depositPaid && job.deposit > 0 && !job.depositPaidDate)
    errors.push(`line ${line}: deposit_paid=y needs deposit_paid_date — the ledger keys received money by date`);
  if (job.balancePaid && !job.balancePaidDate)
    errors.push(`line ${line}: balance_paid=y needs balance_paid_date — the ledger keys received money by date`);
  if (job.deposit != null && job.agreed != null && job.deposit > job.agreed)
    errors.push(`line ${line}: deposit_amount (£${job.deposit}) exceeds agreed_price (£${job.agreed})`);
  if (job.vehicle && !VEHICLES.has(job.vehicle))
    errors.push(`line ${line}: vehicle '${job.vehicle}' not one of ${[...VEHICLES].join("/")}`);
  if (col(r, "deposit_method") && !job.depositMethod)
    errors.push(`line ${line}: deposit_method '${col(r, "deposit_method")}' not bank/card/cash`);
  if (termsRaw && !TERMS_DAYS.has(job.termsDays))
    errors.push(`line ${line}: payment_terms_days '${termsRaw}' must be 30 or 60`);
  // Terms and PO are commercial-only concepts. Silently ignoring them on a
  // residential row would hide a mis-keyed is_company from whoever built the
  // sheet, and that flag decides which payment ladder the customer gets.
  if (termsRaw && !isCompany)
    errors.push(`line ${line}: payment_terms_days is set but is_company is not y — terms apply to commercial accounts only`);
  if (job.poNumber && !isCompany)
    errors.push(`line ${line}: po_number is set but is_company is not y — PO numbers are commercial only`);
  if (job.poNumber && job.poNumber.length > 64)
    errors.push(`line ${line}: po_number is longer than 64 characters`);
  // Commercial is invoiced on completion, on the client's terms — there is no
  // deposit rung in that ladder at all (PRD §3.10), so a deposit on a
  // commercial row means the sheet disagrees with itself.
  if (isCompany && job.deposit > 0)
    errors.push(`line ${line}: is_company=y with a deposit — commercial bookings take no deposit (invoice on completion)`);
  return job;
});
if (errors.length) die(`CSV problems — nothing imported:\n  - ${errors.join("\n  - ")}`);

// Existing state: prior pitmans imports for idempotent re-runs, clients for
// matching. PostgREST caps a plain select at 1,000 rows (PGRST_DB_MAX_ROWS) —
// page everything, or a re-run against a grown table would duplicate clients.
async function fetchAll(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) die(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) return out;
  }
}
const existingQuotes = await fetchAll(() =>
  sb.from("quotes").select("quote_ref, legacy_ref, source").order("id"),
);
// Idempotency is per-ref OCCURRENCE, deliberately ignoring dates: a reschedule
// moves quotes.moving_date, so a date-keyed re-run would re-import the same job
// as a duplicate booking. If Mark's refs turn out to duplicate (iMVE's did), a
// ref seen N times in the DB skips the first N CSV occurrences of that ref.
const importedCountByRef = new Map();
for (const q of existingQuotes) {
  if (q.source === BRAND && q.legacy_ref)
    importedCountByRef.set(q.legacy_ref, (importedCountByRef.get(q.legacy_ref) ?? 0) + 1);
}
const clients = await fetchAll(() =>
  sb.from("clients").select("id, display_name, email, phone_raw, phone_e164, is_company").order("id"),
);

const findClient = (job) => {
  if (job.email) {
    const hit = (clients ?? []).find((c) => normEmail(c.email) === job.email);
    if (hit) return hit;
  }
  const digits = phoneDigits(job.phone);
  if (digits.length >= 10) {
    const hit = (clients ?? []).find(
      (c) => phoneDigits(c.phone_raw) === digits || phoneDigits(c.phone_e164) === digits,
    );
    if (hit) return hit;
  }
  return null;
};

/**
 * Mint the customer-facing reference. Consumes brand_ref_counters, so it is
 * only ever called under --commit; the dry run previews from the counter
 * instead (below) without moving it.
 */
async function mintRef(kind) {
  const { data, error } = await sb.rpc("next_quote_ref", { kind, brand: BRAND });
  if (error || !data) die(`next_quote_ref(${kind}, ${BRAND}) failed — ${error?.message ?? "no ref returned"}`);
  return data;
}

// Duplicate refs INSIDE the CSV are worth flagging, but not fatal — Mark's
// numbering is his own and a repeat may be two genuine jobs.
const refCounts = new Map();
for (const j of jobs) refCounts.set(j.pitmansRef, (refCounts.get(j.pitmansRef) ?? 0) + 1);

const { data: counters } = await sb
  .from("brand_ref_counters")
  .select("kind, n")
  .eq("brand", BRAND);
const counterByKind = new Map((counters ?? []).map((c) => [c.kind, Number(c.n)]));

console.log(`\nbatch '${batch}' — ${jobs.length} rows:\n`);
const plan = [];
const previewNext = new Map(counterByKind);
for (const job of jobs) {
  const priorImports = importedCountByRef.get(job.pitmansRef) ?? 0;
  if (priorImports > 0) {
    importedCountByRef.set(job.pitmansRef, priorImports - 1);
    console.log(
      `  SKIP  ${job.pitmansRef}  ${job.name} — already imported` +
        ((refCounts.get(job.pitmansRef) ?? 0) > 1 ? " (duplicate ref: VERIFY the right occurrence was skipped)" : ""),
    );
    continue;
  }
  const client = findClient(job);
  const kind = job.isCompany ? "C" : "R";
  const policy = job.isCompany ? "commercial" : "residential";
  // Preview only — the real ref is minted at write time by the DB.
  const nextN = (previewNext.get(kind) ?? 0) + 1;
  previewNext.set(kind, nextN);
  const previewRef = `PM${kind}${String(nextN).padStart(3, "0")}`;
  // £0 deposit = Pitmans never took one, and a fully-settled job's deposit
  // landed by definition — either way the booking must not sit in "Awaiting
  // deposit" forever chasing money that isn't owed.
  const depositSettled = job.depositPaid || job.deposit === 0 || job.balancePaid;
  const balance = Math.round((job.agreed - (job.depositPaid ? job.deposit : 0)) * 100) / 100;
  const warnings = [];
  if ((refCounts.get(job.pitmansRef) ?? 0) > 1)
    warnings.push(`pitmans_ref appears ${refCounts.get(job.pitmansRef)}x in this CSV`);
  if (!job.email && !job.phone) warnings.push("no email OR phone — client matching/contact impossible");
  if (client && client.is_company !== job.isCompany)
    warnings.push(
      `existing client '${client.display_name}' is ${client.is_company ? "COMMERCIAL" : "residential"} but this row says ${job.isCompany ? "commercial" : "residential"} — the client record is left as it is`,
    );
  if (job.balancePaid && !job.depositPaid && job.deposit > 0)
    warnings.push(
      "balance_paid without deposit_paid — a settled job implies the deposit landed, importing both as paid" +
        (job.depositPaidDate ? "" : " (deposit stamped from balance_paid_date)"),
    );
  plan.push({ job, client, kind, policy, depositSettled });
  console.log(
    `  ${client ? "MATCH" : "NEW  "} ${job.pitmansRef.padEnd(12)} ${job.name.padEnd(24)} ` +
      `→ ${previewRef}  ${policy === "commercial" ? "COMMERCIAL" : "residential"}  ` +
      `move ${job.movingDate}  £${job.agreed.toFixed(2)}` +
      (job.deposit ? `  dep £${job.deposit.toFixed(2)} ${job.depositPaid ? "PAID" : "unpaid"}` : "  no deposit") +
      (job.balancePaid ? "  SETTLED" : `  balance £${balance.toFixed(2)}`) +
      (client ? `  → client ${client.display_name}` : "") +
      (job.poNumber ? `  PO ${job.poNumber}` : "") +
      (warnings.length ? `\n         ⚠ ${warnings.join(" · ")}` : ""),
  );
}
if (!plan.length) { console.log("\nNothing to do."); process.exit(0); }
if (!commit) {
  console.log(
    `\nDry run — ${plan.length} bookings would import as brand '${BRAND}'.` +
      `\nRefs shown are a PREVIEW from brand_ref_counters (R=${counterByKind.get("R") ?? 0}, C=${counterByKind.get("C") ?? 0});` +
      `\nthe real ones are minted by the DB at write time. Add --commit to write.`,
  );
  process.exit(0);
}

/* ------------------------------------------------------------------- write */

const now = new Date().toISOString();
let imported = 0;
for (const { job, client, kind, policy, depositSettled } of plan) {
  let clientId = client?.id ?? null;
  if (!clientId) {
    const { data: created, error: e } = await sb
      .from("clients")
      .insert({
        display_name: job.name,
        email: job.email,
        phone_raw: job.phone,
        postcode_home: job.fromPostcode,
        is_company: job.isCompany,
        // Terms are meaningful for commercial accounts only; the column is NOT
        // NULL with a default of 30, so a residential row must not write null.
        ...(job.isCompany && job.termsDays ? { payment_terms_days: job.termsDays } : {}),
        import_batch: batch,
      })
      .select("id")
      .single();
    if (e || !created) die(`${job.pitmansRef}: client insert failed — ${e?.message}`);
    clientId = created.id;
    clients.push({
      id: clientId,
      display_name: job.name,
      email: job.email,
      phone_raw: job.phone,
      phone_e164: null,
      is_company: job.isCompany,
    });
  }

  const { data: lead, error: lErr } = await sb
    .from("leads")
    .insert({
      client_id: clientId,
      brand: BRAND,
      status: "confirmed",
      entry_channel: "manual",
      source_system: BRAND,
      import_batch: batch,
      chase_paused: true, // belt-and-braces on top of legacyLocked(source='pitmans')
      date_confirmed_at: now, // booked jobs — the date is real, /schedule shows it firm
      name: job.name,
      email: job.email,
      phone: job.phone,
      from_address: job.fromAddress,
      from_postcode: job.fromPostcode,
      to_address: job.toAddress,
      to_postcode: job.toPostcode,
      preferred_date: job.movingDate,
      notes: job.notes,
      submitted_at: now,
      // Settled-state truth lives on LEADS (post-move auto-complete, the money
      // queue and refunds all read leads.balance_paid_at) — without it a paid
      // imported job would false-alarm "Balance OVERDUE" after move day. The
      // historical date is REQUIRED by validation above; midday keeps the UK
      // day stable across DST.
      balance_paid_at: job.balancePaid ? `${job.balancePaidDate}T12:00:00Z` : null,
    })
    .select("id")
    .single();
  if (lErr || !lead) die(`${job.pitmansRef}: lead insert failed — ${lErr?.message}`);

  // Validation guarantees a date whenever real money is stamped: deposit_paid=y
  // requires deposit_paid_date; a settled job falls back to balance_paid_date
  // (the deposit landed no later than settlement). `now` remains only for the
  // £0-deposit marker rows, which the received ledger skips by amount.
  const depositPaidAt = depositSettled
    ? job.depositPaidDate
      ? `${job.depositPaidDate}T12:00:00Z`
      : job.balancePaidDate
        ? `${job.balancePaidDate}T12:00:00Z`
        : now
    : null;
  const collect = [job.fromAddress, job.fromPostcode].filter(Boolean).join(", ") || null;
  const dest = [job.toAddress, job.toPostcode].filter(Boolean).join(", ") || null;
  const ref = await mintRef(kind);
  const { data: quote, error: quErr } = await sb
    .from("quotes")
    .insert({
      quote_ref: ref,
      legacy_ref: job.pitmansRef,
      brand: BRAND,
      source: BRAND,
      status: "accepted",
      // Snapshotted at import, exactly as acceptance snapshots it for an
      // ordinary booking: changing the client's type later must never re-write
      // an in-flight booking's schedule (PRD §3.10).
      payment_policy: policy,
      po_number: job.poNumber,
      accepted_at: depositPaidAt ?? now,
      lead_id: lead.id,
      client_id: clientId,
      customer_name: job.name,
      customer_email: job.email,
      customer_phone: job.phone,
      collect_addr: collect,
      dest_addr: dest,
      moving_date: job.movingDate,
      moving_date_estimated: false,
      vehicle: job.vehicle,
      // agreed_price/grand_total stay GROSS for every quote (PRD §3.10) — the
      // net/VAT/gross split on a commercial quote is presentation only, so bank
      // matching, margin and invoicing keep reading one consistent number.
      subtotal: job.agreed,
      grand_total: job.agreed,
      agreed_price: job.agreed,
      deposit_amount: job.deposit,
      deposit_paid_at: depositPaidAt,
      deposit_paid_method: job.depositPaid ? job.depositMethod : null,
      breakdown: job.vehicle ? { vehicle: job.vehicle } : {},
      state_blob: {},
    })
    .select("id")
    .single();
  if (quErr || !quote)
    die(`${job.pitmansRef}: quote insert failed — ${quErr?.message} (ref ${ref} was minted and is now burnt; lead ${lead.id} created — roll back the batch and re-run)`);

  const { error: aErr } = await sb.from("appointments").insert({
    appt_type: "removal",
    lead_id: lead.id,
    client_id: clientId,
    brand: BRAND,
    title: `Removal — ${job.name}`,
    starts_at: ukTime(job.movingDate, 8),
    ends_at: ukTime(job.movingDate, 17),
    all_day: false,
    location: collect,
    notes: [`Imported from Pitmans (${job.pitmansRef})`, job.notes].filter(Boolean).join(" — "),
    status: "scheduled",
  });
  if (aErr) die(`${job.pitmansRef}: appointment insert failed — ${aErr.message} (lead ${lead.id} created; roll back the batch and re-run)`);

  const { error: actErr } = await sb.from("activities").insert({
    client_id: clientId,
    lead_id: lead.id,
    type: "note",
    summary: `Imported from Pitmans — ref ${job.pitmansRef} → ${ref}, £${job.agreed.toFixed(2)}${policy === "commercial" ? ", commercial (invoice on completion)" : ""}${job.depositPaid ? `, deposit £${job.deposit.toFixed(2)} received` : ""}${job.balancePaid ? ", fully settled" : ""} (batch ${batch})`,
    meta: { pitmans_ref: job.pitmansRef, quote_ref: ref, import_batch: batch, payment_policy: policy },
  });
  if (actErr) console.warn(`  warning: ${job.pitmansRef} activity note failed — ${actErr.message} (import stands)`);

  imported++;
  console.log(`  imported ${job.pitmansRef} → ${ref} (${job.name})`);
}
console.log(`\ndone — ${imported} imported as batch '${batch}'.`);
console.log(`undo: node scripts/import-pitmans-bookings.mjs --rollback ${batch} --commit${prodOk ? " --prod" : ""}`);
