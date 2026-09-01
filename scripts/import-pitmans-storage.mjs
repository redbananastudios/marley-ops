/**
 * Import Pitmans live storage lets into marley-ops from a CSV. The last of
 * gate 20's four importers (docs/multi-brand-prd.md).
 *
 * One row describes one CUSTOMER IN ONE UNIT, and creates whatever of the chain
 * does not exist yet:
 *   storage site  (matched by name, created if new)
 *   → storage unit (matched by code within that site, created if new)
 *   → client       (matched by email/phone, created if new)
 *   → storage let  (start date, agreed rate, billing model)
 *
 * RATES ARE SNAPSHOTTED, NOT LOOKED UP. Migration 0075 puts rate, rate_period
 * and billing_model on the LET at creation precisely so a later rate-card edit
 * never disturbs a running let. Pitmans customers therefore keep the price Mark
 * agreed with them, with no rate-card change and no override mechanism to
 * build - business_settings.storage_rates stays exactly as it is (PRD §11.10).
 * The rate in the CSV IS the agreed price; nothing recalculates it.
 *
 * BILLING IS LIVE. Unlike a forward booking, an imported let starts billing on
 * the next storage-billing cron run. Rows import with billing_paused=y unless
 * the sheet says otherwise, so money is never taken from a storage customer
 * before somebody has checked the imported figure - the office unpauses per let
 * from /storage. Pass --billing-live to import them ready to bill.
 *
 * Usage (DRY RUN is the default - nothing is written until --commit):
 *   node scripts/import-pitmans-storage.mjs lets.csv
 *   node scripts/import-pitmans-storage.mjs lets.csv --commit
 *   node scripts/import-pitmans-storage.mjs lets.csv --commit --prod
 *   node scripts/import-pitmans-storage.mjs --rollback pitmans-storage-2026-09-21 --commit
 *
 * Env: NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
 *
 * CSV columns (header row required; order free; unknown columns ignored):
 *   site_name*        e.g. "Blandford". Created if it does not exist
 *   site_address      only used when the site is created
 *   unit_code*        unique within the site, e.g. "C-14". Created if new
 *   unit_name         unit_type   crate_250 | container_20ft | container_40ft
 *                                 | room | other        (default crate_250)
 *   size_cuft         number
 *   customer_name*    email        phone
 *   is_company        y/n - a commercial storage account
 *   payment_terms_days  30 (default) or 60 - commercial accounts only
 *   start_date*       YYYY-MM-DD or DD/MM/YYYY - when the let began
 *   end_date          blank = the let is OPEN (still storing)
 *   rate*             the agreed price per period, snapshotted onto the let
 *   rate_period       week | month | day                 (default week)
 *   billing_model     period | crate_daily               (default period)
 *   min_days          min_amount    minimum charge floor, optional
 *   billing_paused    y/n (default y - see BILLING IS LIVE above)
 *   notes             free text
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import {
  contactKey,
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

const BRAND = "pitmans";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const commit = flag("--commit");
const prodOk = flag("--prod");
const billingLive = flag("--billing-live");
const rollbackIdx = args.indexOf("--rollback");
const rollbackBatch = rollbackIdx >= 0 ? args[rollbackIdx + 1] : null;
const batchIdx = args.indexOf("--batch");
const batch =
  batchIdx >= 0 ? args[batchIdx + 1] : `pitmans-storage-${new Date().toISOString().slice(0, 10)}`;
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

const UNIT_TYPES = new Set(["crate_250", "container_20ft", "container_40ft", "room", "other"]);
const RATE_PERIODS = new Set(["week", "month", "day"]);
const BILLING_MODELS = new Set(["period", "crate_daily"]);
const TERMS_DAYS = new Set([30, 60]);
const norm = (v) => String(v ?? "").trim().toLowerCase();

/* ----------------------------------------------------------------- rollback */

if (rollbackBatch) {
  const { data: lets, error } = await sb
    .from("storage_lets")
    .select("id, unit_id, client_id, start_date")
    .eq("import_batch", rollbackBatch);
  if (error) die(error.message);
  const { data: units } = await sb.from("storage_units").select("id, code, site_id").eq("import_batch", rollbackBatch);
  const { data: sites } = await sb.from("storage_sites").select("id, name").eq("import_batch", rollbackBatch);
  if (!lets?.length && !units?.length && !sites?.length)
    die(`Nothing carries import_batch='${rollbackBatch}' — nothing to roll back.`);
  const letIds = (lets ?? []).map((l) => l.id);

  // A let that has been INVOICED is a money record. storage_invoices FK is ON
  // DELETE RESTRICT, so this would fail mid-way anyway — refusing up front says
  // why, instead of leaving a half-deleted chain.
  const blockers = [];
  if (letIds.length) {
    const { data: invs } = await sb.from("storage_invoices").select("id").in("let_id", letIds).limit(5);
    if (invs?.length) blockers.push(`${invs.length}+ storage invoices raised against batch lets`);
    const { data: sigs } = await sb.from("signatures").select("id").in("storage_let_id", letIds).limit(5);
    if (sigs?.length) blockers.push(`${sigs.length}+ signed storage agreements on batch lets`);
    const { data: events } = await sb.from("storage_handling_events").select("id").in("let_id", letIds).limit(5);
    if (events?.length) blockers.push(`${events.length}+ handling events on batch lets`);
  }
  if (blockers.length) die(`Refusing rollback — real records exist:\n  - ${blockers.join("\n  - ")}`);

  console.log(
    `rollback plan for '${rollbackBatch}': ${lets?.length ?? 0} lets, ${units?.length ?? 0} units, ${sites?.length ?? 0} sites`,
  );
  if (!commit) { console.log("\nDry run — add --commit to delete."); process.exit(0); }

  if (letIds.length) {
    const { error: e } = await sb.from("storage_lets").delete().in("id", letIds);
    if (e) die(`storage_lets: ${e.message}`);
  }
  // Units and sites only when nothing outside the batch still points at them —
  // the import may have added a unit to a site that already existed, or a let
  // to a unit somebody has since re-let to another customer.
  for (const u of units ?? []) {
    const { data: otherLets } = await sb.from("storage_lets").select("id").eq("unit_id", u.id).limit(1);
    if (otherLets?.length) { console.warn(`  keeping unit ${u.code} — another let uses it`); continue; }
    const { error: e } = await sb.from("storage_units").delete().eq("id", u.id);
    if (e) console.warn(`  warning: unit ${u.code} not deleted — ${e.message}`);
  }
  for (const s of sites ?? []) {
    const { data: otherUnits } = await sb.from("storage_units").select("id").eq("site_id", s.id).limit(1);
    if (otherUnits?.length) { console.warn(`  keeping site ${s.name} — it still has units`); continue; }
    const { error: e } = await sb.from("storage_sites").delete().eq("id", s.id);
    if (e) console.warn(`  warning: site ${s.name} not deleted — ${e.message}`);
  }
  const { data: createdClients } = await sb.from("clients").select("id").eq("import_batch", rollbackBatch);
  for (const c of createdClients ?? []) {
    const { data: otherLeads } = await sb.from("leads").select("id").eq("client_id", c.id).limit(1);
    const { data: otherLets } = await sb.from("storage_lets").select("id").eq("client_id", c.id).limit(1);
    if (otherLeads?.length || otherLets?.length) continue;
    const { error: e } = await sb.from("clients").delete().eq("id", c.id);
    if (e) console.warn(`  warning: client ${c.id} not deleted — ${e.message}`);
  }
  console.log(`rolled back '${rollbackBatch}'.`);
  process.exit(0);
}

/* ------------------------------------------------------------------- import */

if (!csvPath) die("Usage: node scripts/import-pitmans-storage.mjs <csv> [--commit] [--prod] [--billing-live] [--batch <label>]  |  --rollback <batch>");

const { data: brandRow, error: brandErr } = await sb.from("brands").select("slug, active").eq("slug", BRAND).maybeSingle();
if (brandErr) die(`brands read failed — ${brandErr.message}`);
if (!brandRow) die(`No '${BRAND}' row in brands — apply migration 0104 and seed the brand before importing.`);

const rows = parseCsv(readFileSync(csvPath, "utf8"));
if (rows.length < 2) die("CSV needs a header row + at least one data row.");
const { col } = headerReader(rows[0]);

const errors = [];
const lets = rows.slice(1).map((r, idx) => {
  const line = idx + 2;
  const pausedCell = col(r, "billing_paused");
  const termsRaw = col(r, "payment_terms_days");
  const isCompany = yes(col(r, "is_company"));
  const let_ = {
    line,
    siteName: col(r, "site_name"),
    siteAddress: col(r, "site_address") || "",
    unitCode: col(r, "unit_code"),
    unitName: col(r, "unit_name") || "",
    unitType: norm(col(r, "unit_type")) || "crate_250",
    sizeCuft: col(r, "size_cuft") ? Number(col(r, "size_cuft")) : null,
    name: col(r, "customer_name"),
    email: normEmail(col(r, "email")),
    phone: col(r, "phone") || null,
    isCompany,
    termsDays: termsRaw ? Number(termsRaw) : null,
    startDate: isoDate(col(r, "start_date")),
    endDate: isoDate(col(r, "end_date")),
    rate: money(col(r, "rate")),
    ratePeriod: norm(col(r, "rate_period")) || "week",
    billingModel: norm(col(r, "billing_model")) || "period",
    minDays: col(r, "min_days") ? Number(col(r, "min_days")) : null,
    minAmount: money(col(r, "min_amount")),
    // Default PAUSED. An imported let bills real money on the next cron run,
    // and nobody has checked the figure yet.
    billingPaused: pausedCell ? yes(pausedCell) : !billingLive,
    notes: col(r, "notes") || null,
  };
  if (!let_.siteName) errors.push(`line ${line}: site_name is required`);
  if (!let_.unitCode) errors.push(`line ${line}: unit_code is required`);
  if (!let_.name) errors.push(`line ${line}: customer_name is required`);
  if (!let_.startDate) errors.push(`line ${line}: start_date missing or unreadable (use YYYY-MM-DD or DD/MM/YYYY)`);
  if (col(r, "end_date") && !let_.endDate)
    errors.push(`line ${line}: end_date '${col(r, "end_date")}' unreadable (use YYYY-MM-DD or DD/MM/YYYY)`);
  if (let_.startDate && let_.endDate && let_.endDate < let_.startDate)
    errors.push(`line ${line}: end_date ${let_.endDate} is before start_date ${let_.startDate}`);
  // The rate is the agreed price and nothing recalculates it, so an unreadable
  // or missing one must stop the import rather than store null and bill £0.
  if (let_.rate == null) errors.push(`line ${line}: rate is required and must be a number (it IS the agreed price)`);
  else if (let_.rate <= 0) errors.push(`line ${line}: rate must be greater than 0`);
  if (!UNIT_TYPES.has(let_.unitType))
    errors.push(`line ${line}: unit_type '${let_.unitType}' not one of ${[...UNIT_TYPES].join("/")}`);
  if (!RATE_PERIODS.has(let_.ratePeriod))
    errors.push(`line ${line}: rate_period '${let_.ratePeriod}' not one of ${[...RATE_PERIODS].join("/")}`);
  if (!BILLING_MODELS.has(let_.billingModel))
    errors.push(`line ${line}: billing_model '${let_.billingModel}' not one of ${[...BILLING_MODELS].join("/")}`);
  if (col(r, "size_cuft") && !Number.isFinite(let_.sizeCuft))
    errors.push(`line ${line}: size_cuft '${col(r, "size_cuft")}' is not a number`);
  if (col(r, "min_days") && !Number.isInteger(let_.minDays))
    errors.push(`line ${line}: min_days '${col(r, "min_days")}' must be a whole number`);
  if (col(r, "min_amount") && let_.minAmount == null)
    errors.push(`line ${line}: min_amount '${col(r, "min_amount")}' is not a number`);
  if (termsRaw && !TERMS_DAYS.has(let_.termsDays))
    errors.push(`line ${line}: payment_terms_days '${termsRaw}' must be 30 or 60`);
  if (termsRaw && !isCompany)
    errors.push(`line ${line}: payment_terms_days is set but is_company is not y — terms apply to commercial accounts only`);
  return let_;
});

// Two rows of one sheet can describe the same tenancy in two ways, and NEITHER
// is visible to the planning loop below — it resolves every row against the
// state as it was before the batch, so both rows miss the lookup maps and both
// plan as NEW.
//
// The OPEN case at least has a backstop: one open let per unit is a unique
// index (storage_lets_open_uq), so it would fail at the database. Catching it
// here names the two lines that clash instead of failing halfway through a
// batch with a constraint name and no idea which rows collided.
//
// The CLOSED case has NO backstop, because that index is `unique (unit_id)
// where end_date is null` — open lets only. Closed rows are genuinely in scope
// (the shipped template carries one, "kept for the billing history"), and a
// duplicated one is real money: lib/storage-billing.ts bills every period from
// start_date to end_date, lib/storage/raise-storage-invoices.ts picks up lets
// ended within the last 60 days, and storage_invoices' unique(let_id,
// period_start) cannot dedupe two DIFFERENT let_ids — so an unpaused duplicate
// re-raises the customer's whole tenancy history. Unit + start date is what
// identifies a tenancy: the same unit cannot be let to anyone on the same day.
errors.push(
  ...duplicateKeyErrors(
    lets,
    (l) => (l.endDate || !l.siteName || !l.unitCode ? null : `${norm(l.siteName)}|${norm(l.unitCode)}`),
    (l) => `an OPEN let for ${l.siteName}/${l.unitCode}`,
    "a unit can only be occupied once",
  ),
  ...duplicateKeyErrors(
    lets,
    (l) =>
      !l.siteName || !l.unitCode || !l.startDate
        ? null
        : `${norm(l.siteName)}|${norm(l.unitCode)}|${l.startDate}`,
    (l) => `a let for ${l.siteName}/${l.unitCode} starting ${l.startDate}`,
    "one unit cannot begin two tenancies on the same day, and a duplicated closed let re-bills the whole history",
  ),
);
if (errors.length) die(`CSV problems — nothing imported:\n  - ${errors.join("\n  - ")}`);

const sites = await fetchAllRows(() => sb.from("storage_sites").select("id, name").order("id"), die);
const units = await fetchAllRows(() => sb.from("storage_units").select("id, code, site_id").order("id"), die);
const clients = await fetchAllRows(
  () => sb.from("clients").select("id, display_name, email, phone_raw, phone_e164").order("id"),
  die,
);
// ALL lets, not just open ones. An open let is protected by a unique index
// (storage_lets_open_uq), so a re-run would at worst fail loudly; a CLOSED let
// has no such backstop, and re-importing one silently duplicates a customer's
// billing history. Keyed on unit + start date, which is what identifies a
// tenancy - the same unit cannot be let to anyone else on the same day.
const allLets = await fetchAllRows(
  () => sb.from("storage_lets").select("id, unit_id, client_id, start_date, end_date").order("id"),
  die,
);
const openUnitIds = new Set(allLets.filter((l) => !l.end_date).map((l) => l.unit_id));
const letKeys = new Set(allLets.map((l) => `${l.unit_id}|${l.start_date}`));

const siteByName = new Map(sites.map((s) => [norm(s.name), s]));
const unitByKey = new Map(units.map((u) => [`${u.site_id}|${norm(u.code)}`, u]));
const findClient = (l) => {
  if (l.email) {
    const hit = clients.find((c) => normEmail(c.email) === l.email);
    if (hit) return hit;
  }
  const digits = phoneDigits(l.phone);
  if (digits.length >= 10) {
    const hit = clients.find((c) => phoneDigits(c.phone_raw) === digits || phoneDigits(c.phone_e164) === digits);
    if (hit) return hit;
  }
  return null;
};

console.log(`\nbatch '${batch}' — ${lets.length} rows:\n`);
const plan = [];
// What EARLIER rows of this same sheet would have created by the time this row
// runs. Without them the plan reports "site+" three times for one new site and
// "NEW" twice for one new customer, which reads as three sites and two
// customers to whoever is reviewing the dry run before committing.
const plannedSites = new Set();
const plannedUnits = new Set();
const plannedClients = new Set();
// contactKey, not a hand-rolled `email ?? phone ?? name`. The ?? chain returned
// the EMPTY STRING for a row with no email and no phone — `??` only falls
// through on null/undefined, and phoneDigits("") is "" — so every contactless
// row shared one key: the first printed NEW and the rest printed MATCH, telling
// whoever approves the dry run that several different people were one repeat
// customer. contactKey returns null for such a row, and a null key is never
// added to plannedClients and never looked up in it, so it can never collide.
//
// It errs toward NEW: two rows with DIFFERENT emails but the same phone key as
// `e:` and print NEW twice, where the write path's findClient would match the
// second on phone. Over-reporting new customers is the safe direction — the
// plan may never claim a dedupe the write path will not perform.
const clientKey = (l) => contactKey(l.email, l.phone);
for (const l of lets) {
  const site = siteByName.get(norm(l.siteName)) ?? null;
  const unit = site ? unitByKey.get(`${site.id}|${norm(l.unitCode)}`) ?? null : null;
  const client = findClient(l);
  const key = clientKey(l);
  const siteSeen = !!site || plannedSites.has(norm(l.siteName));
  const unitSeen = !!unit || plannedUnits.has(`${norm(l.siteName)}|${norm(l.unitCode)}`);
  const clientSeen = !!client || (key != null && plannedClients.has(key));

  // Already imported? Two independent reasons to skip.
  if (unit && !l.endDate && openUnitIds.has(unit.id)) {
    console.log(`  SKIP  ${l.siteName}/${l.unitCode} ${l.name} — an OPEN let already occupies this unit`);
    continue;
  }
  if (unit && letKeys.has(`${unit.id}|${l.startDate}`)) {
    console.log(`  SKIP  ${l.siteName}/${l.unitCode} ${l.name} — a let for this unit already starts ${l.startDate}`);
    continue;
  }
  plan.push({ l, site, unit, client });
  plannedSites.add(norm(l.siteName));
  plannedUnits.add(`${norm(l.siteName)}|${norm(l.unitCode)}`);
  if (key != null) plannedClients.add(key);
  const per = l.ratePeriod === "day" ? "day" : l.ratePeriod === "month" ? "mo" : "wk";
  console.log(
    `  ${siteSeen ? "site✓" : "site+"} ${unitSeen ? "unit✓" : "unit+"} ${clientSeen ? "MATCH" : "NEW  "} ` +
      `${`${l.siteName}/${l.unitCode}`.padEnd(22)} ${l.name.padEnd(22)} ` +
      `£${l.rate.toFixed(2)}/${per} ${l.billingModel}` +
      `  from ${l.startDate}${l.endDate ? ` to ${l.endDate}` : " (open)"}` +
      (l.billingPaused ? "  BILLING PAUSED" : "  billing LIVE") +
      (l.isCompany ? `  commercial${l.termsDays ? ` ${l.termsDays}d` : ""}` : ""),
  );
}
if (!plan.length) { console.log("\nNothing to do."); process.exit(0); }
if (!commit) {
  console.log(
    `\nDry run — ${plan.length} lets would import as brand '${BRAND}'.` +
      (billingLive ? "\n--billing-live is set: they would bill on the next cron run." : "\nThey would import with billing PAUSED (pass --billing-live to change that)."),
  );
  process.exit(0);
}

/* ------------------------------------------------------------------- write */

let imported = 0;
for (const entry of plan) {
  const { l } = entry;
  // Re-resolve from the maps, NOT from what planning captured. Planning saw
  // "no Blandford site" for all three rows of one sheet; trusting that here
  // created three separate sites called Blandford, one per row, and the units
  // scattered across them. Every row after the first must see what its
  // predecessors created.
  let site = entry.site ?? siteByName.get(norm(l.siteName)) ?? null;
  if (!site) {
    const { data, error } = await sb
      .from("storage_sites")
      .insert({ name: l.siteName, address: l.siteAddress, brand: BRAND, import_batch: batch })
      .select("id, name")
      .single();
    if (error || !data) die(`${l.siteName}: site insert failed — ${error?.message}`);
    site = data;
    siteByName.set(norm(site.name), site);
  }

  let unit = entry.unit ?? unitByKey.get(`${site.id}|${norm(l.unitCode)}`) ?? null;
  if (!unit) {
    const { data, error } = await sb
      .from("storage_units")
      .insert({
        site_id: site.id,
        code: l.unitCode,
        name: l.unitName || l.unitCode,
        unit_type: l.unitType,
        size_cuft: l.sizeCuft,
        import_batch: batch,
      })
      .select("id, code, site_id")
      .single();
    if (error || !data) die(`${l.siteName}/${l.unitCode}: unit insert failed — ${error?.message}`);
    unit = data;
    unitByKey.set(`${site.id}|${norm(unit.code)}`, unit);
  }

  // Same re-resolution as the site above: two units let to the SAME new
  // customer are two rows, and the second must find the client the first
  // created rather than making a duplicate customer record.
  let clientId = entry.client?.id ?? findClient(l)?.id ?? null;
  if (!clientId) {
    const { data, error } = await sb
      .from("clients")
      .insert({
        display_name: l.name,
        email: l.email,
        phone_raw: l.phone,
        is_company: l.isCompany,
        ...(l.isCompany && l.termsDays ? { payment_terms_days: l.termsDays } : {}),
        import_batch: batch,
      })
      .select("id")
      .single();
    if (error || !data) die(`${l.name}: client insert failed — ${error?.message}`);
    clientId = data.id;
    clients.push({ id: clientId, display_name: l.name, email: l.email, phone_raw: l.phone, phone_e164: null });
  }

  const { error: letErr } = await sb.from("storage_lets").insert({
    unit_id: unit.id,
    client_id: clientId,
    brand: BRAND,
    start_date: l.startDate,
    end_date: l.endDate,
    // Snapshotted, never looked up (migration 0075) — a later rate-card edit
    // must not disturb a running let.
    rate: l.rate,
    rate_period: l.ratePeriod,
    billing_model: l.billingModel,
    min_days: l.minDays,
    min_amount: l.minAmount,
    billing_paused: l.billingPaused,
    notes: l.notes,
    import_batch: batch,
  });
  if (letErr) die(`${l.siteName}/${l.unitCode}: let insert failed — ${letErr.message} (roll back the batch and re-run)`);
  if (!l.endDate) openUnitIds.add(unit.id);
  letKeys.add(`${unit.id}|${l.startDate}`);

  imported++;
  console.log(`  imported ${l.siteName}/${l.unitCode} → ${l.name}`);
}
console.log(`\ndone — ${imported} lets imported as batch '${batch}'.`);
if (!billingLive) console.log(`billing is PAUSED on the imported lets — unpause per let from /storage once the figures are checked.`);
console.log(`undo: node scripts/import-pitmans-storage.mjs --rollback ${batch} --commit${prodOk ? " --prod" : ""}`);
