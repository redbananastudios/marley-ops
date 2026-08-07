/**
 * Import legacy iMVE jobs (booked removals) into marley-ops from a CSV.
 *
 * These are live bookings sold under the OLD system's terms — no 25%-by-T-7
 * commitment, chases handled by humans. Every row imports as:
 *   client (matched by email/phone, created if new)
 *   → lead    (status 'confirmed', source_system 'imve', chase_paused, date-confirmed)
 *   → quote   (status 'accepted', source 'imve', money state from the CSV)
 *   → removal appointment (08:00–17:00 UK on the move date, so /schedule is ONE diary)
 *   → an activity note recording the import.
 *
 * The 'imve' source is HARD-excluded from money automation in the app
 * (commitment invoices, T-10/T-7 ladder, contract-signature nags — see
 * migration 0088). Payments are matched MANUALLY by Peter: iMVE references
 * sometimes duplicate, so nothing auto-matches on them.
 *
 * quote_ref carries the iMVE reference verbatim; on a collision (iMVE refs are
 * not unique) it gets a -2/-3 suffix and the raw value stays in imve_ref.
 *
 * Usage (DRY RUN is the default — nothing is written until --commit):
 *   node scripts/import-imve.mjs jobs.csv                       # plan only
 *   node scripts/import-imve.mjs jobs.csv --commit              # write (staging)
 *   node scripts/import-imve.mjs jobs.csv --commit --prod       # write (prod needs the extra flag)
 *   node scripts/import-imve.mjs --rollback imve-2026-08-07     # undo one batch
 *   node scripts/import-imve.mjs --rollback imve-2026-08-07 --commit [--prod]
 *
 * Env: NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (same pair as the
 * app). Run with `node --env-file=<envfile>` locally, or via the docker
 * `--env-file /opt/marley-ops[-staging]/app.env` pattern on the VPS.
 *
 * CSV columns (header row required; order free; unknown columns ignored):
 *   imve_ref*        old system reference (kept verbatim, duplicates tolerated)
 *   customer_name*
 *   email            phone            (at least one strongly recommended)
 *   from_address     from_postcode    to_address        to_postcode
 *   moving_date*     YYYY-MM-DD or DD/MM/YYYY
 *   agreed_price*    number (no £ sign needed; commas fine)
 *   deposit_amount   number, default 0
 *   deposit_paid     y/n — the deposit has been received
 *   deposit_paid_date YYYY-MM-DD or DD/MM/YYYY (optional; used when deposit_paid)
 *   deposit_method   bank | card | cash (optional)
 *   balance_paid     y/n — the job is fully settled
 *   vehicle          transit | 1luton | 2luton | 3luton | 4luton | 5luton
 *                    (drives crew/van capacity on /schedule; blank = minimum crew)
 *   zoho_invoice_number  Connor's existing Zoho DRAFT for this job (display link only)
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

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const commit = flag("--commit");
const prodOk = flag("--prod");
const rollbackIdx = args.indexOf("--rollback");
const rollbackBatch = rollbackIdx >= 0 ? args[rollbackIdx + 1] : null;
const batchIdx = args.indexOf("--batch");
const batch =
  batchIdx >= 0 ? args[batchIdx + 1] : `imve-${new Date().toISOString().slice(0, 10)}`;
const csvPath = args.find((a) => !a.startsWith("--") && a !== rollbackBatch && a !== batch);

// Staging is a hosted supabase.co project; anything else (the self-hosted prod
// stack) needs the explicit --prod flag so a staging habit can't hit prod.
const looksHosted = /\.supabase\.co/i.test(url);
if (commit && !looksHosted && !prodOk) {
  console.error(`Target ${url} is NOT the hosted staging project — pass --prod if you really mean production.`);
  process.exit(1);
}
console.log(`target: ${url}  (${looksHosted ? "staging/hosted" : "SELF-HOSTED — prod?"})  mode: ${commit ? "COMMIT" : "dry-run"}`);

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
  const foreign = (quotes ?? []).filter((q) => q.source !== "imve");
  if (foreign.length) die(`Batch leads carry NON-imve quotes (${foreign.map((q) => q.quote_ref).join(", ")}) — refusing.`);
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

if (!csvPath) die("Usage: node scripts/import-imve.mjs <csv> [--commit] [--prod] [--batch <label>]  |  --rollback <batch>");
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
  const job = {
    line,
    imveRef: col(r, "imve_ref"),
    name: col(r, "customer_name"),
    email: normEmail(col(r, "email")),
    phone: col(r, "phone") || null,
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
    vehicle: col(r, "vehicle").toLowerCase() || null,
    zohoInvoiceNumber: col(r, "zoho_invoice_number") || null,
    notes: col(r, "notes") || null,
  };
  if (!job.imveRef) errors.push(`line ${line}: imve_ref is required`);
  if (!job.name) errors.push(`line ${line}: customer_name is required`);
  if (!job.movingDate) errors.push(`line ${line}: moving_date missing or unreadable (use YYYY-MM-DD or DD/MM/YYYY)`);
  if (job.agreed == null || job.agreed <= 0) errors.push(`line ${line}: agreed_price missing or not a number`);
  // A non-empty cell the parser can't read must ERROR, never silently default —
  // a £100 deposit mistyped as "1O0" would otherwise import as £0 "settled".
  if (col(r, "deposit_amount") && money(col(r, "deposit_amount")) == null)
    errors.push(`line ${line}: deposit_amount '${col(r, "deposit_amount")}' is not a number`);
  if (col(r, "deposit_paid_date") && !job.depositPaidDate)
    errors.push(`line ${line}: deposit_paid_date '${col(r, "deposit_paid_date")}' unreadable (use YYYY-MM-DD or DD/MM/YYYY)`);
  if (job.deposit != null && job.agreed != null && job.deposit > job.agreed)
    errors.push(`line ${line}: deposit_amount (£${job.deposit}) exceeds agreed_price (£${job.agreed})`);
  if (job.vehicle && !VEHICLES.has(job.vehicle))
    errors.push(`line ${line}: vehicle '${job.vehicle}' not one of ${[...VEHICLES].join("/")}`);
  if (col(r, "deposit_method") && !job.depositMethod)
    errors.push(`line ${line}: deposit_method '${col(r, "deposit_method")}' not bank/card/cash`);
  return job;
});
if (errors.length) die(`CSV problems — nothing imported:\n  - ${errors.join("\n  - ")}`);

// Existing state: refs for collision handling, clients for matching, prior
// imve imports for idempotent re-runs. PostgREST caps a plain select at 1,000
// rows (PGRST_DB_MAX_ROWS) — page everything, or a re-run against a grown
// table would miss refs (UNIQUE violation mid-batch) and duplicate clients.
async function fetchAll(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) die(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) return out;
  }
}
const existingQuotes = await fetchAll(() => sb.from("quotes").select("quote_ref, imve_ref, source").order("id"));
const takenRefs = new Set(existingQuotes.map((q) => q.quote_ref));
// Idempotency is per-ref OCCURRENCE, deliberately ignoring dates: a reschedule
// moves quotes.moving_date, so a date-keyed re-run would re-import the same
// job as a duplicate booking. iMVE refs duplicate across distinct jobs, so a
// ref seen N times in the DB skips the first N CSV occurrences of that ref.
const importedCountByRef = new Map();
for (const q of existingQuotes) {
  if (q.source === "imve" && q.imve_ref)
    importedCountByRef.set(q.imve_ref, (importedCountByRef.get(q.imve_ref) ?? 0) + 1);
}
const clients = await fetchAll(() =>
  sb.from("clients").select("id, display_name, email, phone_raw, phone_e164").order("id"),
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

const assignRef = (imveRef) => {
  if (!takenRefs.has(imveRef)) { takenRefs.add(imveRef); return imveRef; }
  for (let n = 2; n < 100; n++) {
    const candidate = `${imveRef}-${n}`;
    if (!takenRefs.has(candidate)) { takenRefs.add(candidate); return candidate; }
  }
  die(`Could not find a free quote_ref for ${imveRef}`);
};

// Duplicate iMVE refs INSIDE the CSV are legal (iMVE duplicated them) but each
// row must be a distinct job — flag same-ref rows so Peter double-checks.
const refCounts = new Map();
for (const j of jobs) refCounts.set(j.imveRef, (refCounts.get(j.imveRef) ?? 0) + 1);

console.log(`\nbatch '${batch}' — ${jobs.length} rows:\n`);
const plan = [];
for (const job of jobs) {
  const priorImports = importedCountByRef.get(job.imveRef) ?? 0;
  if (priorImports > 0) {
    importedCountByRef.set(job.imveRef, priorImports - 1);
    console.log(
      `  SKIP  ${job.imveRef}  ${job.name} — already imported` +
        ((refCounts.get(job.imveRef) ?? 0) > 1 ? " (duplicate ref: VERIFY the right occurrence was skipped)" : ""),
    );
    continue;
  }
  const client = findClient(job);
  const ref = assignRef(job.imveRef);
  // £0 deposit = iMVE never took one, and a fully-settled job's deposit landed
  // by definition — either way the booking must not sit in "Awaiting deposit"
  // forever chasing money that isn't owed.
  const depositSettled = job.depositPaid || job.deposit === 0 || job.balancePaid;
  const balance = Math.round((job.agreed - (job.depositPaid ? job.deposit : 0)) * 100) / 100;
  const warnings = [];
  if ((refCounts.get(job.imveRef) ?? 0) > 1) warnings.push(`imve_ref appears ${refCounts.get(job.imveRef)}x in this CSV`);
  if (!job.email && !job.phone) warnings.push("no email OR phone — client matching/contact impossible");
  if (ref !== job.imveRef) warnings.push(`quote_ref '${ref}' (raw iMVE ref kept in imve_ref)`);
  if (job.balancePaid && !job.depositPaid && job.deposit > 0)
    warnings.push("balance_paid without deposit_paid — a settled job implies the deposit landed, importing both as paid");
  if (job.depositPaid && !job.depositPaidDate)
    warnings.push("deposit_paid without a date — receipt will show today's date");
  plan.push({ job, client, ref, depositSettled });
  console.log(
    `  ${client ? "MATCH" : "NEW  "} ${job.imveRef.padEnd(12)} ${job.name.padEnd(24)} ` +
      `move ${job.movingDate}  £${job.agreed.toFixed(2)}` +
      (job.deposit ? `  dep £${job.deposit.toFixed(2)} ${job.depositPaid ? "PAID" : "unpaid"}` : "  no deposit (iMVE terms)") +
      (job.balancePaid ? "  SETTLED" : `  balance £${balance.toFixed(2)}`) +
      (client ? `  → client ${client.display_name}` : "") +
      (job.zohoInvoiceNumber ? `  zoho ${job.zohoInvoiceNumber}` : "") +
      (warnings.length ? `\n         ⚠ ${warnings.join(" · ")}` : ""),
  );
}
if (!plan.length) { console.log("\nNothing to do."); process.exit(0); }
if (!commit) { console.log(`\nDry run — ${plan.length} jobs would import. Add --commit to write.`); process.exit(0); }

/* ------------------------------------------------------------------- write */

const now = new Date().toISOString();
let imported = 0;
for (const { job, client, ref, depositSettled } of plan) {
  let clientId = client?.id ?? null;
  if (!clientId) {
    const { data: created, error: e } = await sb
      .from("clients")
      .insert({
        display_name: job.name,
        email: job.email,
        phone_raw: job.phone,
        postcode_home: job.fromPostcode,
        import_batch: batch,
      })
      .select("id")
      .single();
    if (e || !created) die(`${job.imveRef}: client insert failed — ${e?.message}`);
    clientId = created.id;
    clients.push({ id: clientId, display_name: job.name, email: job.email, phone_raw: job.phone, phone_e164: null });
  }

  const { data: lead, error: lErr } = await sb
    .from("leads")
    .insert({
      client_id: clientId,
      status: "confirmed",
      entry_channel: "manual",
      source_system: "imve",
      import_batch: batch,
      chase_paused: true, // belt-and-braces: even a status regression never re-enters the chase engine
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
      // legacy job would false-alarm "Balance OVERDUE" after move day.
      balance_paid_at: job.balancePaid ? now : null,
    })
    .select("id")
    .single();
  if (lErr || !lead) die(`${job.imveRef}: lead insert failed — ${lErr?.message}`);

  const depositPaidAt = depositSettled
    ? job.depositPaidDate ? `${job.depositPaidDate}T12:00:00Z` : now
    : null;
  const collect = [job.fromAddress, job.fromPostcode].filter(Boolean).join(", ") || null;
  const dest = [job.toAddress, job.toPostcode].filter(Boolean).join(", ") || null;
  const { data: quote, error: quErr } = await sb
    .from("quotes")
    .insert({
      quote_ref: ref,
      imve_ref: job.imveRef,
      source: "imve",
      status: "accepted",
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
      subtotal: job.agreed,
      grand_total: job.agreed,
      agreed_price: job.agreed,
      deposit_amount: job.deposit,
      deposit_paid_at: depositPaidAt,
      deposit_paid_method: job.depositPaid ? job.depositMethod : null,
      imve_zoho_invoice_number: job.zohoInvoiceNumber,
      breakdown: job.vehicle ? { vehicle: job.vehicle } : {},
      state_blob: {},
    })
    .select("id")
    .single();
  if (quErr || !quote) die(`${job.imveRef}: quote insert failed — ${quErr?.message}`);

  const { error: aErr } = await sb.from("appointments").insert({
    appt_type: "removal",
    lead_id: lead.id,
    client_id: clientId,
    title: `Removal — ${job.name}`,
    starts_at: ukTime(job.movingDate, 8),
    ends_at: ukTime(job.movingDate, 17),
    all_day: false,
    location: collect,
    notes: [`Imported from iMVE (${job.imveRef})`, job.notes].filter(Boolean).join(" — "),
    status: "scheduled",
  });
  if (aErr) die(`${job.imveRef}: appointment insert failed — ${aErr.message} (lead ${lead.id} created; roll back the batch and re-run)`);

  const { error: actErr } = await sb.from("activities").insert({
    client_id: clientId,
    lead_id: lead.id,
    type: "note",
    summary: `Imported from iMVE — ref ${job.imveRef}, £${job.agreed.toFixed(2)}${job.depositPaid ? `, deposit £${job.deposit.toFixed(2)} received` : ""}${job.balancePaid ? ", fully settled" : ""}${job.zohoInvoiceNumber ? `, Zoho draft ${job.zohoInvoiceNumber}` : ""} (batch ${batch})`,
    meta: { imve_ref: job.imveRef, import_batch: batch, zoho_invoice_number: job.zohoInvoiceNumber },
  });
  if (actErr) console.warn(`  warning: ${job.imveRef} activity note failed — ${actErr.message} (import stands)`);

  imported++;
  console.log(`  imported ${job.imveRef} → ${ref} (${job.name})`);
}
console.log(`\ndone — ${imported} imported as batch '${batch}'.`);
console.log(`undo: node scripts/import-imve.mjs --rollback ${batch} --commit${prodOk ? " --prod" : ""}`);
