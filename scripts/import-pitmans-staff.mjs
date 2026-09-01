/**
 * Import Pitmans staff (crew, drivers, office) into marley-ops from a CSV.
 * Gate 20 of docs/multi-brand-prd.md.
 *
 * Staff carry NO brand, deliberately (PRD §3.2): the crew is one shared pool
 * across both brands, engaged by the one legal entity, and per-person pay
 * statements are a group surface. A brand column here would invite someone to
 * filter a crew day by brand, which is exactly how you double-book a person.
 *
 * This creates STAFF rows, not logins. profiles is the login layer and
 * staff.profile_id links the two; a crew member who needs to sign in gets an
 * account through the normal /join flow, which is a human decision about access
 * and not something a bulk import should make.
 *
 * Usage (DRY RUN is the default - nothing is written until --commit):
 *   node scripts/import-pitmans-staff.mjs crew.csv
 *   node scripts/import-pitmans-staff.mjs crew.csv --commit
 *   node scripts/import-pitmans-staff.mjs crew.csv --commit --prod
 *   node scripts/import-pitmans-staff.mjs --rollback pitmans-staff-2026-09-21 --commit
 *
 * Env: NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
 *
 * CSV columns (header row required; order free; unknown columns ignored):
 *   full_name*        as payroll knows them
 *   staff_role        crew | driver | estimator | admin      (default crew)
 *   is_driver         y/n - holds the licence and drives (default y for the
 *                     'driver' role, n otherwise)
 *   phone             email
 *   day_rate          number - what they are paid per day
 *   working_days      digits for the days they normally work, 1=Mon..7=Sun,
 *                     e.g. "12345" or "1,2,3,4,5"
 *   date_of_birth     YYYY-MM-DD or DD/MM/YYYY
 *   address
 *   emergency_contact_name    emergency_contact_phone
 *   is_active         y/n (default y)
 *   notes             free text
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import {
  duplicateKeyErrors,
  fetchAllRows,
  headerReader,
  isoDate,
  money,
  normEmail,
  parseCsv,
  phoneDigits,
  TARGET_LABEL,
  targetKind,
  yes,
} from "./lib/import-csv.mjs";

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
  batchIdx >= 0 ? args[batchIdx + 1] : `pitmans-staff-${new Date().toISOString().slice(0, 10)}`;
const csvPath = args.find((a) => !a.startsWith("--") && a !== rollbackBatch && a !== batch);

const kindOfTarget = targetKind(url);
if (commit && kindOfTarget === "prod" && !prodOk) {
  console.error(`Target ${url} is NOT the hosted staging project or a local Supabase — pass --prod if you really mean production.`);
  process.exit(1);
}
console.log(`target: ${url}  (${TARGET_LABEL[kindOfTarget]})  mode: ${commit ? "COMMIT" : "dry-run"}`);

const sb = createClient(url, serviceKey, { auth: { persistSession: false } });
const die = (msg) => {
  console.error(`\nFATAL: ${msg}`);
  process.exit(1);
};

const ROLES = new Set(["crew", "driver", "estimator", "admin"]);

/** How a person's name is compared: trimmed, lowercased, runs of space collapsed. */
const key = (name) => String(name ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/** "12345" or "1,2,3" or "1 2 3" -> [1,2,3,4,5]; deduped and sorted. */
function workingDays(raw) {
  const digits = String(raw ?? "").match(/[1-7]/g);
  if (!digits) return null;
  return [...new Set(digits.map(Number))].sort((a, b) => a - b);
}

/* ----------------------------------------------------------------- rollback */

if (rollbackBatch) {
  const { data: people, error } = await sb
    .from("staff")
    .select("id, full_name, profile_id")
    .eq("import_batch", rollbackBatch);
  if (error) die(error.message);
  if (!people?.length) die(`No staff carry import_batch='${rollbackBatch}' — nothing to roll back.`);
  const ids = people.map((p) => p.id);

  const blockers = [];
  // Somebody rostered onto a job, or who has been paid, is not deletable: the
  // allocation and the pay line are the record of work actually done.
  const { data: assigned } = await sb
    .from("appointment_assignments")
    .select("appointment_id")
    .in("staff_id", ids)
    .limit(5);
  if (assigned?.length) blockers.push(`${assigned.length}+ appointment allocations`);
  const { data: paid } = await sb
    .from("staff_statement_lines")
    .select("id")
    .in("staff_id", ids)
    .limit(5);
  if (paid?.length) blockers.push(`${paid.length}+ pay-statement lines`);
  const linked = people.filter((p) => p.profile_id);
  if (linked.length) blockers.push(`${linked.length} linked to a login (profile_id set)`);
  if (blockers.length) {
    die(
      `Refusing rollback — real records exist:\n  - ${blockers.join("\n  - ")}\n` +
        `Mark them inactive instead; a person who has worked or been paid is not deletable.`,
    );
  }

  console.log(`rollback plan for '${rollbackBatch}': ${people.length} staff`);
  for (const p of people) console.log(`  - ${p.full_name}`);
  if (!commit) { console.log("\nDry run — add --commit to delete."); process.exit(0); }

  const { error: dErr } = await sb.from("staff").delete().in("id", ids);
  if (dErr) die(`staff: ${dErr.message}`);
  console.log(`rolled back '${rollbackBatch}'.`);
  process.exit(0);
}

/* ------------------------------------------------------------------- import */

if (!csvPath) die("Usage: node scripts/import-pitmans-staff.mjs <csv> [--commit] [--prod] [--batch <label>]  |  --rollback <batch>");

const rows = parseCsv(readFileSync(csvPath, "utf8"));
if (rows.length < 2) die("CSV needs a header row + at least one data row.");
const { col } = headerReader(rows[0]);

const errors = [];
const people = rows.slice(1).map((r, idx) => {
  const line = idx + 2;
  const role = (col(r, "staff_role") || "crew").toLowerCase();
  const driverCell = col(r, "is_driver");
  const activeCell = col(r, "is_active");
  const person = {
    line,
    fullName: col(r, "full_name"),
    role,
    // A 'driver' who is not a driver is a typo, so the role supplies the
    // default rather than a blanket false that would quietly shrink the pool
    // of people the office can allocate to a van.
    isDriver: driverCell ? yes(driverCell) : role === "driver",
    phone: col(r, "phone") || null,
    email: normEmail(col(r, "email")),
    dayRate: money(col(r, "day_rate")),
    workingDays: workingDays(col(r, "working_days")),
    dateOfBirth: isoDate(col(r, "date_of_birth")),
    address: col(r, "address") || null,
    emergencyName: col(r, "emergency_contact_name") || null,
    emergencyPhone: col(r, "emergency_contact_phone") || null,
    isActive: activeCell ? yes(activeCell) : true,
    notes: col(r, "notes") || null,
  };
  if (!person.fullName) errors.push(`line ${line}: full_name is required`);
  if (!ROLES.has(person.role))
    errors.push(`line ${line}: staff_role '${person.role}' not one of ${[...ROLES].join("/")}`);
  if (col(r, "day_rate") && person.dayRate == null)
    errors.push(`line ${line}: day_rate '${col(r, "day_rate")}' is not a number`);
  if (col(r, "date_of_birth") && !person.dateOfBirth)
    errors.push(`line ${line}: date_of_birth '${col(r, "date_of_birth")}' unreadable (use YYYY-MM-DD or DD/MM/YYYY)`);
  if (col(r, "working_days") && !person.workingDays)
    errors.push(`line ${line}: working_days '${col(r, "working_days")}' has no day numbers (1=Mon..7=Sun)`);
  return person;
});

// byName/byPhone/byEmail below are built ONCE from the pre-batch database read
// and are never mutated, so a duplicate INSIDE this sheet is invisible to the
// planning loop: neither row matches anything, both plan as NEW, and both go
// into a single .insert() — one person, two payroll records, two people to
// allocate to the same crew day.
//
// All three match columns are checked, because all three are what the loop
// below matches on. The NAME check is the strictest of the three by design: two
// rows sharing a name would collapse to one on a re-run (the loop skips a
// name-only match to VERIFY), so importing them as two people now guarantees
// the sheet and the database disagree. If they really are two different people,
// that has to be a human decision made before a one-shot live import, not a
// silent insert.
errors.push(
  ...duplicateKeyErrors(
    people,
    (p) => p.email,
    (p) => `the email ${p.email}`,
    "one person would import twice",
  ),
  ...duplicateKeyErrors(
    people,
    (p) => (phoneDigits(p.phone).length >= 10 ? phoneDigits(p.phone) : null),
    (p) => `the phone ${p.phone}`,
    "one person would import twice",
  ),
  ...duplicateKeyErrors(
    people,
    (p) => key(p.fullName) || null,
    (p) => `the name '${p.fullName}'`,
    "the import cannot tell two people of one name apart — remove the repeat, or if they really are two people, import the second separately",
  ),
);
if (errors.length) die(`CSV problems — nothing imported:\n  - ${errors.join("\n  - ")}`);

const existing = await fetchAllRows(() => sb.from("staff").select("id, full_name, phone, email").order("id"), die);
const byName = new Map(existing.map((s) => [key(s.full_name), s]));
const byPhone = new Map();
for (const s of existing) if (phoneDigits(s.phone).length >= 10) byPhone.set(phoneDigits(s.phone), s);
const byEmail = new Map();
for (const s of existing) if (normEmail(s.email)) byEmail.set(normEmail(s.email), s);

// Two people can genuinely share a name, so a name-only match is reported as a
// match to VERIFY rather than silently skipped as certainly-the-same-person.
console.log(`\nbatch '${batch}' — ${people.length} rows:\n`);
const plan = [];
for (const p of people) {
  const byId =
    (p.email && byEmail.get(p.email)) ||
    (phoneDigits(p.phone).length >= 10 && byPhone.get(phoneDigits(p.phone))) ||
    null;
  const nameOnly = !byId && byName.get(key(p.fullName));
  if (byId) {
    console.log(`  SKIP  ${p.fullName.padEnd(22)} — already present (matched on ${p.email && byEmail.get(p.email) ? "email" : "phone"})`);
    continue;
  }
  if (nameOnly) {
    console.log(`  SKIP  ${p.fullName.padEnd(22)} — a staff row already has this NAME. VERIFY it is the same person; if not, re-run with a distinguishing email or phone.`);
    continue;
  }
  plan.push(p);
  console.log(
    `  NEW   ${p.fullName.padEnd(22)} ${p.role.padEnd(9)} ${p.isDriver ? "driver" : "      "} ` +
      (p.dayRate != null ? ` £${p.dayRate.toFixed(2)}/day` : "") +
      (p.workingDays ? `  days ${p.workingDays.join("")}` : "") +
      (p.isActive ? "" : "  INACTIVE"),
  );
}
if (!plan.length) { console.log("\nNothing to do."); process.exit(0); }
if (!commit) { console.log(`\nDry run — ${plan.length} staff would import. Add --commit to write.`); process.exit(0); }

/* ------------------------------------------------------------------- write */

const { data: written, error: wErr } = await sb
  .from("staff")
  .insert(
    plan.map((p) => ({
      full_name: p.fullName,
      staff_role: p.role,
      is_driver: p.isDriver,
      phone: p.phone,
      email: p.email,
      day_rate: p.dayRate,
      ...(p.workingDays ? { working_days: p.workingDays } : {}),
      date_of_birth: p.dateOfBirth,
      address: p.address,
      emergency_contact_name: p.emergencyName,
      emergency_contact_phone: p.emergencyPhone,
      is_active: p.isActive,
      notes: p.notes,
      import_batch: batch,
    })),
  )
  .select("id, full_name");
if (wErr) die(`staff insert failed — ${wErr.message} (nothing written: the batch inserts as one statement)`);

for (const s of written ?? []) console.log(`  imported ${s.full_name}`);
console.log(`\ndone — ${written?.length ?? 0} imported as batch '${batch}'.`);
console.log(`undo: node scripts/import-pitmans-staff.mjs --rollback ${batch} --commit${prodOk ? " --prod" : ""}`);
