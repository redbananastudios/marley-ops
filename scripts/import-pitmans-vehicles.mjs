/**
 * Import Pitmans vehicles into marley-ops from a CSV. Gate 20 of
 * docs/multi-brand-prd.md.
 *
 * The fleet is ONE pool across both brands (PRD §4 /resources): vehicles.brand
 * is LIVERY only. It drives a soft, informational warning when a van whose
 * livery differs from the job's brand is allocated, and nothing else - it never
 * restricts which van can take which job. A van that is unbranded or shared
 * imports with brand blank, which never mismatches and so never warns.
 *
 * Usage (DRY RUN is the default - nothing is written until --commit):
 *   node scripts/import-pitmans-vehicles.mjs vans.csv
 *   node scripts/import-pitmans-vehicles.mjs vans.csv --commit
 *   node scripts/import-pitmans-vehicles.mjs vans.csv --commit --prod
 *   node scripts/import-pitmans-vehicles.mjs --rollback pitmans-vans-2026-09-21 --commit
 *
 * Env: NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
 *
 * CSV columns (header row required; order free; unknown columns ignored):
 *   name*             callsign as the office says it, e.g. "Luton 3"
 *   registration      UK plate. Used to match a van already in the system, so
 *                     a re-run updates nothing and duplicates nothing
 *   vehicle_type      luton | transit | 7.5t | other      (default luton)
 *   brand             pitmans | marley | (blank = unbranded/shared livery)
 *   tax_due           mot_due    insurance_renewal    last_service
 *                     end_of_term        YYYY-MM-DD or DD/MM/YYYY
 *   cost_per_month    number
 *   payment_day       1-31
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
  parseCsv,
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
  batchIdx >= 0 ? args[batchIdx + 1] : `pitmans-vans-${new Date().toISOString().slice(0, 10)}`;
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

const TYPES = new Set(["luton", "transit", "7.5t", "other"]);
const plate = (v) => String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/* ----------------------------------------------------------------- rollback */

if (rollbackBatch) {
  const { data: vans, error } = await sb
    .from("vehicles")
    .select("id, name, registration")
    .eq("import_batch", rollbackBatch);
  if (error) die(error.message);
  if (!vans?.length) die(`No vehicles carry import_batch='${rollbackBatch}' — nothing to roll back.`);
  const ids = vans.map((v) => v.id);

  // A van that has been allocated to a job is load-bearing: deleting it would
  // strip the vehicle off a real appointment (and appointment_assignments
  // cascades), leaving a crew day with no van and no record of which one it
  // was. Refuse and say so rather than quietly unassigning.
  //
  // The error is FATAL, never discarded: `const { data } = …` on a failed query
  // leaves `data` undefined, so `assigned?.length` is falsy and the refusal
  // never fires — the gate would pass precisely when it could not check. The
  // staff importer shipped that exact shape.
  const { data: assigned, error: assignedErr } = await sb
    .from("appointment_assignments")
    .select("appointment_id, vehicle_id")
    .in("vehicle_id", ids)
    .limit(5);
  if (assignedErr) {
    die(
      `Rollback safety check FAILED (appointment_assignments.vehicle_id): ${assignedErr.message}\n` +
        `  Refusing. A check that could not run is not a clean result.`,
    );
  }
  if (assigned?.length) {
    die(
      `Refusing rollback — ${assigned.length}+ appointment allocations use vehicles in this batch. ` +
        `Unassign them first, or keep the vans and mark them inactive.`,
    );
  }

  console.log(`rollback plan for '${rollbackBatch}': ${vans.length} vehicles`);
  for (const v of vans) console.log(`  - ${v.name}${v.registration ? ` (${v.registration})` : ""}`);
  if (!commit) { console.log("\nDry run — add --commit to delete."); process.exit(0); }

  const { error: dErr } = await sb.from("vehicles").delete().in("id", ids);
  if (dErr) die(`vehicles: ${dErr.message}`);
  console.log(`rolled back '${rollbackBatch}'.`);
  process.exit(0);
}

/* ------------------------------------------------------------------- import */

if (!csvPath) die("Usage: node scripts/import-pitmans-vehicles.mjs <csv> [--commit] [--prod] [--batch <label>]  |  --rollback <batch>");

const { data: brandRows, error: brandErr } = await sb.from("brands").select("slug");
if (brandErr) die(`brands read failed — ${brandErr.message}`);
const knownBrands = new Set((brandRows ?? []).map((b) => b.slug));

const rows = parseCsv(readFileSync(csvPath, "utf8"));
if (rows.length < 2) die("CSV needs a header row + at least one data row.");
const { col } = headerReader(rows[0]);

const errors = [];
const vans = rows.slice(1).map((r, idx) => {
  const line = idx + 2;
  const isActiveCell = col(r, "is_active");
  const van = {
    line,
    name: col(r, "name"),
    registration: col(r, "registration") || "",
    vehicleType: (col(r, "vehicle_type") || "luton").toLowerCase(),
    // Blank means unbranded/shared, which is a real and common answer - stored
    // as null so it never mismatches and never warns at allocation.
    brand: col(r, "brand").toLowerCase() || null,
    taxDue: isoDate(col(r, "tax_due")),
    motDue: isoDate(col(r, "mot_due")),
    insuranceRenewal: isoDate(col(r, "insurance_renewal")),
    lastService: isoDate(col(r, "last_service")),
    endOfTerm: isoDate(col(r, "end_of_term")),
    costPerMonth: money(col(r, "cost_per_month")),
    paymentDay: col(r, "payment_day") ? Number(col(r, "payment_day")) : null,
    isActive: isActiveCell ? yes(isActiveCell) : true,
    notes: col(r, "notes") || null,
  };
  if (!van.name) errors.push(`line ${line}: name is required`);
  if (!TYPES.has(van.vehicleType))
    errors.push(`line ${line}: vehicle_type '${van.vehicleType}' not one of ${[...TYPES].join("/")}`);
  if (van.brand && !knownBrands.has(van.brand))
    errors.push(`line ${line}: brand '${van.brand}' is not a row in brands (leave blank for unbranded/shared)`);
  // Every date column is validated the same way, because a compliance date that
  // silently imports as null is an MOT nobody is reminded about.
  for (const [cell, parsed] of [
    ["tax_due", van.taxDue],
    ["mot_due", van.motDue],
    ["insurance_renewal", van.insuranceRenewal],
    ["last_service", van.lastService],
    ["end_of_term", van.endOfTerm],
  ]) {
    if (col(r, cell) && !parsed)
      errors.push(`line ${line}: ${cell} '${col(r, cell)}' unreadable (use YYYY-MM-DD or DD/MM/YYYY)`);
  }
  if (col(r, "cost_per_month") && van.costPerMonth == null)
    errors.push(`line ${line}: cost_per_month '${col(r, "cost_per_month")}' is not a number`);
  if (van.paymentDay != null && (!Number.isInteger(van.paymentDay) || van.paymentDay < 1 || van.paymentDay > 31))
    errors.push(`line ${line}: payment_day '${col(r, "payment_day")}' must be a whole number 1-31`);
  return van;
});

// byPlate/byName below are built ONCE from the pre-batch database read and are
// never mutated, so a duplicate INSIDE this sheet is invisible to the planning
// loop: neither row is in those maps, both plan as NEW, and both go into a
// single .insert() that has nothing to key on. vehicles (migration 0020) has no
// unique index on registration or name, and 0114 adds only a non-unique partial
// index on import_batch, so nothing downstream catches it either. A fleet sheet
// listing one van under two callsigns is exactly the input this hits.
//
// Both columns are checked because BOTH are used to match: registration first
// (it identifies a physical vehicle), name as the fallback for a van whose
// plate Mark did not supply. A collision on either would collapse to one row on
// a re-run, so it must not create two rows now.
errors.push(
  ...duplicateKeyErrors(
    vans,
    (v) => plate(v.registration) || null,
    (v) => `registration '${v.registration}'`,
    "one physical vehicle would import as two",
  ),
  ...duplicateKeyErrors(
    vans,
    (v) => v.name.trim().toLowerCase() || null,
    (v) => `the callsign '${v.name}'`,
    "the office allocates by callsign, and a re-run matching on name would then pick an arbitrary one of the two",
  ),
);
if (errors.length) die(`CSV problems — nothing imported:\n  - ${errors.join("\n  - ")}`);

const existing = await fetchAllRows(() => sb.from("vehicles").select("id, name, registration").order("id"), die);
const byPlate = new Map();
for (const v of existing) if (plate(v.registration)) byPlate.set(plate(v.registration), v);
const byName = new Map(existing.map((v) => [v.name.trim().toLowerCase(), v]));

console.log(`\nbatch '${batch}' — ${vans.length} rows:\n`);
const plan = [];
for (const van of vans) {
  // Registration first (it identifies a physical vehicle), name as the fallback
  // for a van whose plate Mark did not supply.
  const hit = (van.registration && byPlate.get(plate(van.registration))) || byName.get(van.name.trim().toLowerCase());
  if (hit) {
    console.log(`  SKIP  ${van.name.padEnd(16)} — already present as '${hit.name}'${hit.registration ? ` (${hit.registration})` : ""}`);
    continue;
  }
  plan.push(van);
  console.log(
    `  NEW   ${van.name.padEnd(16)} ${van.vehicleType.padEnd(8)} ${(van.registration || "no plate").padEnd(10)} ` +
      `livery ${van.brand ?? "unbranded/shared"}` +
      (van.motDue ? `  MOT ${van.motDue}` : "") +
      (van.isActive ? "" : "  INACTIVE"),
  );
}
if (!plan.length) { console.log("\nNothing to do."); process.exit(0); }
if (!commit) { console.log(`\nDry run — ${plan.length} vehicles would import. Add --commit to write.`); process.exit(0); }

/* ------------------------------------------------------------------- write */

const { data: written, error: wErr } = await sb
  .from("vehicles")
  .insert(
    plan.map((v) => ({
      name: v.name,
      registration: v.registration,
      vehicle_type: v.vehicleType,
      brand: v.brand,
      tax_due: v.taxDue,
      mot_due: v.motDue,
      insurance_renewal: v.insuranceRenewal,
      last_service: v.lastService,
      end_of_term: v.endOfTerm,
      cost_per_month: v.costPerMonth,
      payment_day: v.paymentDay,
      is_active: v.isActive,
      notes: v.notes,
      import_batch: batch,
    })),
  )
  .select("id, name");
if (wErr) die(`vehicles insert failed — ${wErr.message} (nothing written: the batch inserts as one statement)`);

for (const v of written ?? []) console.log(`  imported ${v.name}`);
console.log(`\ndone — ${written?.length ?? 0} imported as batch '${batch}'.`);
console.log(`undo: node scripts/import-pitmans-vehicles.mjs --rollback ${batch} --commit${prodOk ? " --prod" : ""}`);
