/**
 * E2E SEED — resets the target to the KNOWN state the Playwright suite asserts
 * against (e2e/fixtures/seed-data.ts). Fully idempotent: it deletes every row it
 * previously created (marked E2E-SEED / named "E2E …" / ref "E2E-…") and
 * re-creates them, so a re-run always lands the same state and never touches
 * hand-made data.
 *
 * Constants MUST match e2e/fixtures/seed-data.ts.
 *
 * SAFETY: refuses to run without SEED_CONFIRM=yes, and never seeds real
 * customer contacts (everything points at the sink). Do NOT run against prod.
 *
 * Usage:
 *   SEED_CONFIRM=yes node --env-file=.env.staging scripts/seed-e2e.mjs
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
if (process.env.SEED_CONFIRM !== "yes") {
  console.error(`REFUSING to seed ${url} — set SEED_CONFIRM=yes if you really mean it.`);
  process.exit(1);
}

const sb = createClient(url, serviceKey, { auth: { persistSession: false } });

// ── constants (keep in lockstep with e2e/fixtures/seed-data.ts) ───────────────
const MARKER = "E2E-SEED";
const SINK_EMAIL = process.env.E2E_SINK_EMAIL || "e2e@marleymoves.test";
const SINK_PHONE = process.env.E2E_SINK_PHONE || "07700900000";
const CREW_EMAIL = process.env.E2E_CREW_EMAIL || "e2e-crew@marleymoves.test";
const SEED = {
  crewJobCustomer: { name: "E2E Crew Job Customer", quoteRef: "E2E-CREW-001" },
  crewJobTwo: { name: "E2E Crew Job Two", quoteRef: "E2E-CREW-002" },
  freshEnquiry: { name: "E2E Fresh Enquiry" },
  awaitingDeposit: { name: "E2E Awaiting Deposit", quoteRef: "E2E-DEP-001" },
  balanceDue: { name: "E2E Balance Due", quoteRef: "E2E-BAL-001" },
  sentQuote: { name: "E2E Sent Quote", quoteRef: "E2E-SENT-001", acceptToken: "e2e-sent-accept-token-0001", total: 1500 },
  declineQuote: { name: "E2E Decline Quote", quoteRef: "E2E-DECLINE-001", acceptToken: "e2e-decline-token-0001", total: 900 },
  vehicle: { name: "E2E Luton", registration: "E2E 001" },
  storageAgreement: { client: "E2E Storage Client", signToken: "e2e-storage-sign-token-0001", site: "E2E Storage Site", unitCode: "E2E-U1" },
  cubicSurvey: { name: "E2E Cubic Survey", shareToken: "e2e-cubic-share-token-0001" },
  daySheet: { token: "e2e-day-sheet-token-0001" },
};
const DAY = 86_400_000;
const at = (daysFromNow, hour = 9) => {
  const d = new Date(Date.now() + daysFromNow * DAY);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};
const die = (msg, err) => {
  console.error(msg, err?.message ?? err ?? "");
  process.exit(1);
};

// ── clean up any prior E2E rows (FK-safe order) ───────────────────────────────
// Every child table that references a lead (directly or via its appointments).
// Crew sign-off writes job_completions (RESTRICT on appointment) and claims
// (RESTRICT on lead), so a naive lead/appointment delete is BLOCKED and rows
// pile up until quote_ref collides. Clear the whole chain, deepest first.
const LEAD_CHILD_TABLES = [
  "claims",
  "job_completions",
  "card_payments",
  "communications",
  "activities",
  "surveys",
  "storage_lets",
  "signatures",
  "job_notes",
  "job_media",
  "cubic_surveys",
  "follow_ups",
];

async function wipe() {
  const { data: leads } = await sb.from("leads").select("id").ilike("name", "E2E %");
  const leadIds = (leads ?? []).map((l) => l.id);
  if (leadIds.length) {
    const { data: appts } = await sb.from("appointments").select("id").in("lead_id", leadIds);
    const apptIds = (appts ?? []).map((a) => a.id);
    for (const t of LEAD_CHILD_TABLES) {
      const { error } = await sb.from(t).delete().in("lead_id", leadIds);
      // A table that doesn't exist in this schema is fine to skip; anything else fails loud.
      if (error && !/does not exist|find the table/i.test(error.message)) die(`wipe ${t}`, error);
    }
    if (apptIds.length) {
      await sb.from("staff_statement_lines").delete().in("appointment_id", apptIds);
      await sb.from("appointment_assignments").delete().in("appointment_id", apptIds);
    }
    await sb.from("appointments").delete().in("lead_id", leadIds);
    await sb.from("quotes").delete().in("lead_id", leadIds);
    await sb.from("leads").delete().in("id", leadIds);
  }
  // Storage lets carry lead_id=NULL, so the lead-child pass above misses them —
  // and their client (E2E Storage Client) is about to be deleted, which the let's
  // FK would block. Clear the whole storage chain (deepest first) by our markers.
  const { data: eSites } = await sb.from("storage_sites").select("id").ilike("name", "E2E %");
  const siteIds = (eSites ?? []).map((s) => s.id);
  if (siteIds.length) {
    const { data: eUnits } = await sb.from("storage_units").select("id").in("site_id", siteIds);
    const unitIds = (eUnits ?? []).map((u) => u.id);
    if (unitIds.length) {
      const { data: eLets } = await sb.from("storage_lets").select("id").in("unit_id", unitIds);
      const letIds = (eLets ?? []).map((l) => l.id);
      if (letIds.length) {
        await sb.from("signatures").delete().in("storage_let_id", letIds);
        const { error: invErr } = await sb.from("storage_invoices").delete().in("let_id", letIds);
        if (invErr && !/does not exist|find the table/i.test(invErr.message)) die("wipe storage_invoices", invErr);
        await sb.from("storage_lets").delete().in("id", letIds);
      }
      await sb.from("storage_units").delete().in("id", unitIds);
    }
    await sb.from("storage_sites").delete().in("id", siteIds);
  }
  // Crew day-sheet token is unique — a re-seed would collide; clear it.
  await sb.from("crew_job_sheets").delete().eq("token", SEED.daySheet.token);
  await sb.from("clients").delete().ilike("display_name", "E2E %");
  console.log(`wiped prior E2E data (${leadIds.length} leads)`);
}

// ── helpers ───────────────────────────────────────────────────────────────────
async function ensureVehicle() {
  // ilike (not eq): the app matches registration/email case-insensitively, so a
  // case difference must find the existing row, never create a duplicate.
  const { data: existing } = await sb.from("vehicles").select("id").ilike("registration", SEED.vehicle.registration).maybeSingle();
  if (existing) return existing.id;
  const { data, error } = await sb
    .from("vehicles")
    .insert({ name: SEED.vehicle.name, registration: SEED.vehicle.registration, is_active: true })
    .select("id")
    .single();
  if (error) die("vehicle", error);
  return data.id;
}

async function ensureCrewStaff() {
  const { data: existing } = await sb.from("staff").select("id, profile_id").ilike("email", CREW_EMAIL).maybeSingle();
  const { data: profile } = await sb.from("profiles").select("id").ilike("email", CREW_EMAIL).maybeSingle();
  if (existing) {
    if (profile && existing.profile_id !== profile.id) await sb.from("staff").update({ profile_id: profile.id }).eq("id", existing.id);
    return existing.id;
  }
  const { data, error } = await sb
    .from("staff")
    .insert({ full_name: "E2E Crew", staff_role: "crew", email: CREW_EMAIL, phone: SINK_PHONE, profile_id: profile?.id ?? null, is_active: true })
    .select("id")
    .single();
  if (error) die("crew staff", error);
  if (!profile) console.warn(`  ⚠ no auth profile for ${CREW_EMAIL} — create the user + re-run so the crew tests can sign in.`);
  return data.id;
}

async function makeLead(t) {
  const { data: client, error: cErr } = await sb
    .from("clients")
    .insert({ display_name: t.name, postcode_home: "SP7 8AA", notes: `${MARKER}` })
    .select("id")
    .single();
  if (cErr) die(`${t.name} client`, cErr);
  const { data: lead, error: lErr } = await sb
    .from("leads")
    .insert({
      client_id: client.id,
      status: t.status,
      entry_channel: "manual",
      source_system: "marley_ops",
      name: t.name,
      phone: SINK_PHONE,
      email: SINK_EMAIL,
      from_address: "1 Test Street, Shaftesbury",
      from_postcode: "SP7 8AA",
      to_address: "2 Sample Road, Gillingham",
      to_postcode: "SP8 4AB",
      property_size: "3 bedroom",
      notes: `${MARKER} — ${t.status}`,
    })
    .select("id")
    .single();
  if (lErr) die(`${t.name} lead`, lErr);
  return { clientId: client.id, leadId: lead.id };
}

async function makeQuote(ids, t, q) {
  const { data, error } = await sb
    .from("quotes")
    .insert({
      quote_ref: q.ref,
      client_id: ids.clientId,
      lead_id: ids.leadId,
      customer_name: t.name,
      customer_email: SINK_EMAIL,
      customer_phone: SINK_PHONE,
      subtotal: q.total,
      grand_total: q.total,
      status: q.status,
      moving_date: q.movingDate ?? null,
      deposit_amount: q.deposit ?? 100,
      accepted_at: q.acceptedAt ?? null,
      agreed_price: q.acceptedAt ? q.total : null,
      breakdown: { vehicle: "1luton", totalMiles: 20 },
      state_blob: { seeded: MARKER, job: { days: 1 } },
    })
    .select("id")
    .single();
  if (error) die(`${t.name} quote`, error);
  return data.id;
}

async function makeRemoval(ids, startsIso, staffId, vehicleId, title) {
  const { data: appt, error } = await sb
    .from("appointments")
    .insert({
      appt_type: "removal",
      client_id: ids.clientId,
      lead_id: ids.leadId,
      title,
      starts_at: startsIso,
      ends_at: new Date(new Date(startsIso).getTime() + 5 * 3_600_000).toISOString(),
      status: "scheduled",
      location: "seed",
    })
    .select("id")
    .single();
  if (error) die(`${title} appt`, error);
  // appointment_assignments enforces XOR (staff_id IS NULL) <> (vehicle_id IS NULL):
  // one row per resource — a staff row AND a separate vehicle row, never both in one.
  const { error: aErr } = await sb.from("appointment_assignments").insert([
    { appointment_id: appt.id, staff_id: staffId },
    { appointment_id: appt.id, vehicle_id: vehicleId },
  ]);
  if (aErr) die(`${title} assignment`, aErr);
  return appt.id;
}

// ── seed ──────────────────────────────────────────────────────────────────────
await wipe();
const vehicleId = await ensureVehicle();
const crewStaffId = await ensureCrewStaff();

// Contractor-invoicing state: switch the feature ON, give the crew a pay rate,
// and RESET the crew's signed agreement + any prior statements so the crew
// contractor spec (gate → sign → unlock) starts from a clean, unsigned state
// every run.
async function resetCrewContractorState() {
  // Feature toggle (singleton row keyed id=true).
  await sb.from("business_settings").update({ self_billing_enabled: true }).eq("id", true);
  // Crew pay rate (the invoice pre-fills from staff_pay).
  await sb.from("staff_pay").upsert({ staff_id: crewStaffId, hourly_rate: 15, weekly_guarantee: null }, { onConflict: "staff_id" });
  // Clear prior statements for the crew (lines first — FK), then the agreement,
  // so the sign gate reappears unsigned.
  const { data: stmts } = await sb.from("staff_statements").select("id").eq("staff_id", crewStaffId);
  const stmtIds = (stmts ?? []).map((s) => s.id);
  if (stmtIds.length) {
    await sb.from("staff_statement_lines").delete().in("statement_id", stmtIds);
    await sb.from("staff_statements").delete().in("id", stmtIds);
  }
  const { data: prof } = await sb.from("profiles").select("id").ilike("email", CREW_EMAIL).maybeSingle();
  if (prof) await sb.from("contractor_agreements").delete().eq("profile_id", prof.id);
  console.log("reset crew contractor state: self-billing ON, rate £15/hr, agreement cleared");
}
await resetCrewContractorState();

// 1. Crew job — accepted quote + removal TOMORROW + e2e-crew assigned (crew journey + P0 #7/#8).
{
  const ids = await makeLead({ name: SEED.crewJobCustomer.name, status: "confirmed" });
  await makeQuote(ids, SEED.crewJobCustomer, {
    ref: SEED.crewJobCustomer.quoteRef,
    total: 1800,
    status: "accepted",
    movingDate: at(1).slice(0, 10),
    acceptedAt: at(-2),
    deposit: 100,
  });
  await makeRemoval(ids, at(1), crewStaffId, vehicleId, SEED.crewJobCustomer.name);
  console.log(`seeded crew job: ${SEED.crewJobCustomer.name} (removal tomorrow, e2e-crew assigned)`);
}

// 1b. A SECOND crew job — the double-submit scenario (P0 #8) needs its own job
// because P0 #7 completes the first one.
{
  const ids = await makeLead({ name: SEED.crewJobTwo.name, status: "confirmed" });
  await makeQuote(ids, SEED.crewJobTwo, {
    ref: SEED.crewJobTwo.quoteRef,
    total: 1800,
    status: "accepted",
    movingDate: at(1).slice(0, 10),
    acceptedAt: at(-2),
    deposit: 100,
  });
  await makeRemoval(ids, at(1), crewStaffId, vehicleId, SEED.crewJobTwo.name);
  console.log(`seeded crew job 2: ${SEED.crewJobTwo.name} (removal tomorrow, e2e-crew assigned)`);
}

// 2. Fresh enquiry — office/estimator entry point.
{
  await makeLead({ name: SEED.freshEnquiry.name, status: "website_enquiry" });
  console.log(`seeded fresh enquiry: ${SEED.freshEnquiry.name}`);
}

// 3. Accepted quote awaiting a deposit — deposit/card scenario.
{
  const ids = await makeLead({ name: SEED.awaitingDeposit.name, status: "confirmed" });
  await makeQuote(ids, SEED.awaitingDeposit, {
    ref: SEED.awaitingDeposit.quoteRef,
    total: 1200,
    status: "accepted",
    movingDate: at(5).slice(0, 10),
    acceptedAt: at(-1),
    deposit: 100,
  });
  console.log(`seeded awaiting-deposit: ${SEED.awaitingDeposit.name}`);
}

// 4. Completed move, balance outstanding — balance-invoice scenario.
{
  const ids = await makeLead({ name: SEED.balanceDue.name, status: "completed" });
  await makeQuote(ids, SEED.balanceDue, {
    ref: SEED.balanceDue.quoteRef,
    total: 2400,
    status: "accepted",
    movingDate: at(-1).slice(0, 10),
    acceptedAt: at(-4),
    deposit: 100,
  });
  await makeRemoval(ids, at(-1), crewStaffId, vehicleId, SEED.balanceDue.name);
  console.log(`seeded balance-due: ${SEED.balanceDue.name}`);
}

// 5. A SENT quote with a share token — the public customer accept page /q/<token>.
{
  const ids = await makeLead({ name: SEED.sentQuote.name, status: "quoted" });
  const { error } = await sb.from("quotes").insert({
    quote_ref: SEED.sentQuote.quoteRef,
    client_id: ids.clientId,
    lead_id: ids.leadId,
    customer_name: SEED.sentQuote.name,
    customer_email: SINK_EMAIL,
    customer_phone: SINK_PHONE,
    subtotal: SEED.sentQuote.total,
    grand_total: SEED.sentQuote.total,
    status: "sent",
    moving_date: at(7).slice(0, 10),
    deposit_amount: 100,
    accept_token: SEED.sentQuote.acceptToken,
    email_sent_at: at(-1), // sent yesterday — within the 30-day validity window
    collect_addr: "1 Test Street, Shaftesbury, SP7 8AA",
    dest_addr: "2 Sample Road, Gillingham, SP8 4AB",
    vat_enabled: true,
    breakdown: { vehicle: "1luton", totalMiles: 20 },
    state_blob: { seeded: MARKER },
  });
  if (error) die(`${SEED.sentQuote.name} sent quote`, error);
  console.log(`seeded sent quote: ${SEED.sentQuote.name} (/q/${SEED.sentQuote.acceptToken})`);
}

// 6. A second SENT quote with a token — the public DECLINE flow (kept separate
// so declining never consumes the accept quote).
{
  const ids = await makeLead({ name: SEED.declineQuote.name, status: "quoted" });
  const { error } = await sb.from("quotes").insert({
    quote_ref: SEED.declineQuote.quoteRef,
    client_id: ids.clientId,
    lead_id: ids.leadId,
    customer_name: SEED.declineQuote.name,
    customer_email: SINK_EMAIL,
    customer_phone: SINK_PHONE,
    subtotal: SEED.declineQuote.total,
    grand_total: SEED.declineQuote.total,
    status: "sent",
    moving_date: at(7).slice(0, 10),
    deposit_amount: 100,
    accept_token: SEED.declineQuote.acceptToken,
    email_sent_at: at(-1),
    collect_addr: "1 Test Street, Shaftesbury, SP7 8AA",
    dest_addr: "2 Sample Road, Gillingham, SP8 4AB",
    vat_enabled: true,
    breakdown: { vehicle: "1luton", totalMiles: 20 },
    state_blob: { seeded: MARKER },
  });
  if (error) die(`${SEED.declineQuote.name} sent quote`, error);
  console.log(`seeded decline quote: ${SEED.declineQuote.name} (/q/${SEED.declineQuote.acceptToken})`);
}

// 7. An OPEN, UNSIGNED storage let with a remote-signing token — /s/<token>.
{
  const { data: client, error: cErr } = await sb
    .from("clients")
    .insert({ display_name: SEED.storageAgreement.client, postcode_home: "SP7 8AA", notes: MARKER })
    .select("id")
    .single();
  if (cErr) die("storage client", cErr);
  const { data: site, error: sErr } = await sb
    .from("storage_sites")
    .insert({ name: SEED.storageAgreement.site, address: "Yard Lane, Shaftesbury, SP7 8AA", is_active: true, notes: MARKER })
    .select("id")
    .single();
  if (sErr) die("storage site", sErr);
  const { data: unit, error: uErr } = await sb
    .from("storage_units")
    .insert({ site_id: site.id, code: SEED.storageAgreement.unitCode, name: "Crate 1", unit_type: "crate_250", size_cuft: 250, is_active: true, notes: MARKER })
    .select("id")
    .single();
  if (uErr) die("storage unit", uErr);
  const { error: lErr } = await sb.from("storage_lets").insert({
    client_id: client.id,
    unit_id: unit.id,
    start_date: at(0).slice(0, 10),
    rate: 25,
    rate_period: "week",
    sign_token: SEED.storageAgreement.signToken,
    notes: MARKER,
  });
  if (lErr) die("storage let", lErr);
  console.log(`seeded storage let: ${SEED.storageAgreement.client} (/s/${SEED.storageAgreement.signToken})`);
}

// 8. A cubic survey with a customer share token — /cv/<token> self-fill.
{
  const ids = await makeLead({ name: SEED.cubicSurvey.name, status: "quoted" });
  const { error } = await sb.from("cubic_surveys").insert({
    lead_id: ids.leadId,
    client_id: ids.clientId,
    status: "draft",
    items: [{ key: "sofa_2", label: "2-seat sofa", qty: 1, ft3: 35 }],
    customer_notes: "",
    notes: MARKER,
    share_token: SEED.cubicSurvey.shareToken,
  });
  if (error) die("cubic survey", error);
  console.log(`seeded cubic survey: ${SEED.cubicSurvey.name} (/cv/${SEED.cubicSurvey.shareToken})`);
}

// 9. A crew day-sheet token for the e2e-crew staff, TOMORROW (their seeded
//    crew job's day, inside the 3-day staleness window) — /sheet/<token>.
{
  const { error } = await sb.from("crew_job_sheets").insert({
    staff_id: crewStaffId,
    work_date: at(1).slice(0, 10),
    token: SEED.daySheet.token,
    version: 1,
    attempts: 0,
    content_hash: "e2e-seed",
  });
  if (error) die("crew day sheet", error);
  console.log(`seeded day sheet: e2e-crew tomorrow (/sheet/${SEED.daySheet.token})`);
}

console.log("\n✓ E2E seed complete.");
