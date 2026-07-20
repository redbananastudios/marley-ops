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
  freshEnquiry: { name: "E2E Fresh Enquiry" },
  awaitingDeposit: { name: "E2E Awaiting Deposit", quoteRef: "E2E-DEP-001" },
  balanceDue: { name: "E2E Balance Due", quoteRef: "E2E-BAL-001" },
  vehicle: { name: "E2E Luton", registration: "E2E 001" },
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
async function wipe() {
  const { data: leads } = await sb.from("leads").select("id").ilike("name", "E2E %");
  const leadIds = (leads ?? []).map((l) => l.id);
  if (leadIds.length) {
    const { data: appts } = await sb.from("appointments").select("id").in("lead_id", leadIds);
    const apptIds = (appts ?? []).map((a) => a.id);
    if (apptIds.length) await sb.from("appointment_assignments").delete().in("appointment_id", apptIds);
    await sb.from("appointments").delete().in("lead_id", leadIds);
    await sb.from("quotes").delete().in("lead_id", leadIds);
    await sb.from("leads").delete().in("id", leadIds);
  }
  await sb.from("clients").delete().ilike("display_name", "E2E %");
  console.log(`wiped prior E2E data (${leadIds.length} leads)`);
}

// ── helpers ───────────────────────────────────────────────────────────────────
async function ensureVehicle() {
  const { data: existing } = await sb.from("vehicles").select("id").eq("registration", SEED.vehicle.registration).maybeSingle();
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
  const { data: existing } = await sb.from("staff").select("id, profile_id").eq("email", CREW_EMAIL).maybeSingle();
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
  const { error: aErr } = await sb.from("appointment_assignments").insert({ appointment_id: appt.id, staff_id: staffId, vehicle_id: vehicleId });
  if (aErr) die(`${title} assignment`, aErr);
  return appt.id;
}

// ── seed ──────────────────────────────────────────────────────────────────────
await wipe();
const vehicleId = await ensureVehicle();
const crewStaffId = await ensureCrewStaff();

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

console.log("\n✓ E2E seed complete.");
