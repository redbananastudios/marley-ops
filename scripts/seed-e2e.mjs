/**
 * E2E SEED — resets the target to the KNOWN state the Playwright suite asserts
 * against (e2e/fixtures/seed-data.ts). Fully idempotent: it deletes every row it
 * previously created (marked E2E-SEED / named "E2E …" / ref "E2E-…") and
 * re-creates them, so a re-run always lands the same state and never touches
 * hand-made data.
 *
 * Constants MUST match e2e/fixtures/seed-data.ts.
 *
 * SAFETY: refuses to run without SEED_CONFIRM=yes, hard-refuses the prod Supabase
 * host, and never seeds real customer contacts (everything points at the sink).
 *
 * ORDERING: run scripts/create-e2e-users.mjs FIRST — the crew AND estimator auth
 * profiles must exist so this seed can link the crew/estimator staff rows and the
 * estimator-pay unlock; block 13 warns-and-skips if the estimator profile is
 * absent (which then surfaces as a confusing "gate still showing" in estimator/pay).
 *
 * PERSISTENT ROWS: the E2E staff rows (E2E Crew, E2E Pay Crew, E2E Estimator) and
 * the E2E Luton vehicle intentionally persist across runs (find-or-reuse), unlike
 * the lead/client/storage rows which wipe() clears by name. Each such block
 * delete-before-inserts its own children (statements, agreements) so re-runs stay
 * idempotent; the staff rows themselves are stable resources.
 *
 * Usage:
 *   SEED_CONFIRM=yes node --env-file=.env.local --env-file=.env.e2e scripts/seed-e2e.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { CUBIC_SURVEY_SEED_ITEMS } from "./seed-e2e-fixtures.mjs";

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
// Prod guard — this is the most destructive script in the suite (it wipes rows
// AND flips business_settings.self_billing_enabled). Hard-refuse the prod
// Supabase host outright; require an explicit extra confirm for any other
// non-local target. Mirrors scripts/create-e2e-users.mjs.
const isLocal = url.includes("127.0.0.1") || url.includes("localhost") || url.includes("://i9");
if (url.includes("supabase.redbananastudios.com")) {
  console.error(`REFUSING: ${url} is the PRODUCTION Supabase host. The E2E seed never runs against prod.`);
  process.exit(1);
}
if (!isLocal && process.env.SEED_REMOTE_CONFIRM !== "yes") {
  console.error(`Target is NOT local (${url}). Re-run with SEED_REMOTE_CONFIRM=yes to seed a remote (staging) target.`);
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
  crewJobThree: { name: "E2E Crew Job Three", quoteRef: "E2E-CREW-003" },
  freshEnquiry: { name: "E2E Fresh Enquiry" },
  awaitingDeposit: { name: "E2E Awaiting Deposit", quoteRef: "E2E-DEP-001" },
  balanceDue: { name: "E2E Balance Due", quoteRef: "E2E-BAL-001" },
  sentQuote: { name: "E2E Sent Quote", quoteRef: "E2E-SENT-001", acceptToken: "e2e-sent-accept-token-0001", total: 1500 },
  lateQuote: {
    name: "E2E Late Booking",
    quoteRef: "E2E-LATE-001",
    acceptToken: "e2e-late-accept-token-0001",
    total: 2000,
    collapsedDeposit: 500,
    balance: 1500,
  },
  declineQuote: { name: "E2E Decline Quote", quoteRef: "E2E-DECLINE-001", acceptToken: "e2e-decline-token-0001", total: 900 },
  draftQuote: { name: "E2E Draft Quote", quoteRef: "E2E-DRAFT-001", total: 1200 },
  vehicle: { name: "E2E Luton", registration: "E2E 001" },
  markLost: { name: "E2E Mark Lost" },
  storageAgreement: { client: "E2E Storage Client", signToken: "e2e-storage-sign-token-0001", site: "E2E Storage Site", unitCode: "E2E-U1" },
  cubicSurvey: { name: "E2E Cubic Survey", shareToken: "e2e-cubic-share-token-0001" },
  daySheet: { token: "e2e-day-sheet-token-0001" },
  payCrew: { name: "E2E Pay Crew", statementRef: "MMP-E2E01" },
  claim: { name: "E2E Claim Lead" },
  followUp: { name: "E2E Follow-up Lead" },
  joinApplicant: { token: "e2e-join-token-0001", name: "E2E Join Applicant" },
  resendRaceDeposit: { name: "E2E Resend Race Deposit", quoteRef: "E2E-RRACE-DEP-001", invoiceNumber: "E2E-DEP-INV-001", amount: 100 },
  resendRaceCommitment: { name: "E2E Resend Race Commitment", quoteRef: "E2E-RRACE-COM-001", invoiceNumber: "E2E-COM-INV-001", amount: 450 },
  resendRaceBalance: { name: "E2E Resend Race Balance", quoteRef: "E2E-RRACE-BAL-001", invoiceNumber: "E2E-BAL-INV-001", amount: 1250 },
};
const ESTIMATOR_EMAIL = process.env.E2E_ESTIMATOR_EMAIL || "e2e-estimator@marleymoves.test";
// Derive the agreement version + ack keys from the app's source of truth so a
// future v2 bump (which re-prompts everyone) can't leave the seed signing a stale
// version — that would silently re-show the sign gate and fail estimator/pay.spec.
const AGREEMENT_SRC = readFileSync(new URL("../lib/contractor/agreement.ts", import.meta.url), "utf8");
const CONTRACTOR_AGREEMENT_VERSION = AGREEMENT_SRC.match(/CONTRACTOR_AGREEMENT_VERSION\s*=\s*["']([^"']+)["']/)?.[1];
const CONTRACTOR_ACKS = Object.fromEntries(
  [...AGREEMENT_SRC.matchAll(/key:\s*["'](\w+)["']/g)].map((m) => [m[1], true]),
);
if (!CONTRACTOR_AGREEMENT_VERSION || Object.keys(CONTRACTOR_ACKS).length < 5) {
  console.error("Could not derive the contractor agreement version/acks from lib/contractor/agreement.ts");
  process.exit(1);
}
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
  "refund_queue", // payments v2 — RESTRICTs leads/quotes; one blocked row aborts the whole lead delete
  "card_payments",
  "communications",
  "activities",
  // NOTE: the surveys table is deliberately NOT in this list. appointments.survey_id is a
  // second, deeper FK into surveys (NO ACTION — see 0001_init.sql), so a survey can
  // only go once its appointments have. Deleting it here dies on that FK *before*
  // the appointment delete below, and because die() exits, the row that broke the
  // run survives to break every later run identically. Cleared post-appointments.
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
    // Surveys come out only now that the appointments referencing them are gone.
    // Belt and braces: an appointment whose own lead_id fell outside the sweep
    // above can still hold a survey_id, so release those links first rather than
    // letting the FK abort the whole wipe.
    const { data: surveyRows } = await sb.from("surveys").select("id").in("lead_id", leadIds);
    const surveyIds = (surveyRows ?? []).map((s) => s.id);
    if (surveyIds.length) {
      await sb.from("appointments").update({ survey_id: null }).in("survey_id", surveyIds);
      const { error } = await sb.from("surveys").delete().in("id", surveyIds);
      if (error) die("wipe surveys", error);
    }
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
        // Handling events RESTRICT their let — clear them before the lets.
        const { error: evErr } = await sb.from("storage_handling_events").delete().in("let_id", letIds);
        if (evErr && !/does not exist|find the table/i.test(evErr.message)) die("wipe storage_handling_events", evErr);
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
  // The /join spec POSTs a real application each run. actions.ts updates a still-
  // PENDING row in place (same email+phone), but if the office has since
  // approved/rejected it a re-seed would otherwise insert a stray duplicate —
  // clear any prior E2E applications outright so every seed starts unclaimed.
  await sb.from("staff_submissions").delete().ilike("full_name", "E2E %");
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

// 1c. A THIRD crew job — P0 #7 COMPLETES its job, so it owns a dedicated one no
// read-only spec depends on (journey/job-detail read crewJobCustomer).
{
  const ids = await makeLead({ name: SEED.crewJobThree.name, status: "confirmed" });
  await makeQuote(ids, SEED.crewJobThree, {
    ref: SEED.crewJobThree.quoteRef,
    total: 1800,
    status: "accepted",
    movingDate: at(1).slice(0, 10),
    acceptedAt: at(-2),
    deposit: 100,
  });
  await makeRemoval(ids, at(1), crewStaffId, vehicleId, SEED.crewJobThree.name);
  console.log(`seeded crew job 3: ${SEED.crewJobThree.name} (removal tomorrow, e2e-crew assigned)`);
}

// 2. Fresh enquiry — office/estimator entry point.
{
  await makeLead({ name: SEED.freshEnquiry.name, status: "website_enquiry" });
  console.log(`seeded fresh enquiry: ${SEED.freshEnquiry.name}`);
}

// 2b. A quoted lead + its quote — the office mark-lost (reason-gated) test.
{
  const ids = await makeLead({ name: SEED.markLost.name, status: "quoted" });
  await makeQuote(ids, SEED.markLost, { ref: "E2E-LOST-001", total: 1100, status: "sent" });
  console.log(`seeded mark-lost candidate: ${SEED.markLost.name}`);
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

// 4b. Invoice RE-SEND race jobs — one per rail (deposit / 25% commitment /
// balance). Each is an accepted job whose invoice on that rail is already RAISED
// and still UNPAID, which is exactly the state the "send it again" dialog serves.
//
// The Zoho ids are STUBS and `zoho_contact_id` stays NULL on purpose: every paid
// pipeline gates its Zoho call on a real contact id, so nothing this spec drives
// can reach a Zoho org even if a guard is broken. The invoice NUMBERS are unique
// per rail because the spec scopes its assertions to them.
//
// Each stub also carries its `*_invoice_provider` stamp (migrations 0109/0110).
// This script writes invoice ids with the service role, bypassing the app's raise
// paths, so it is a WRITER the stamp rule applies to just as much as accept-flow
// is — and the CHECK constraint refuses the row without it. That is how this was
// found: 0110 would not apply to staging because these three seeded rows violated
// it. Any future fixture that sets an invoice id must stamp it too.
{
  const r = SEED.resendRaceDeposit;
  const ids = await makeLead({ name: r.name, status: "confirmed" });
  const quoteId = await makeQuote(ids, r, {
    ref: r.quoteRef,
    total: 1200,
    status: "accepted",
    movingDate: at(21).slice(0, 10),
    acceptedAt: at(-2),
    deposit: r.amount,
  });
  // Accepting raises the -DEP invoice and stamps deposit_requested_at; both are
  // what puts the lead's Payments card into "requested · unpaid", the branch
  // carrying the Deposit-invoice re-send button.
  const { error: qErr } = await sb
    .from("quotes")
    .update({
      zoho_deposit_invoice_id: "e2e-zoho-dep-0001",
      deposit_invoice_provider: "zoho",
      zoho_deposit_invoice_number: r.invoiceNumber,
      accept_token: "e2e-resend-dep-token-0001",
    })
    .eq("id", quoteId);
  if (qErr) die(`${r.name} deposit invoice`, qErr);
  const { error: lErr } = await sb
    .from("leads")
    .update({ deposit_amount: r.amount, deposit_requested_at: at(-2), deposit_paid_at: null })
    .eq("id", ids.leadId);
  if (lErr) die(`${r.name} lead deposit state`, lErr);
  console.log(`seeded resend-race deposit: ${r.name} (${r.invoiceNumber}, £${r.amount} unpaid)`);
}

{
  const r = SEED.resendRaceCommitment;
  const ids = await makeLead({ name: r.name, status: "confirmed" });
  const quoteId = await makeQuote(ids, r, {
    ref: r.quoteRef,
    total: 1800,
    status: "accepted",
    movingDate: at(21).slice(0, 10),
    acceptedAt: at(-5),
    deposit: 100,
  });
  // A date-confirmed job: the deposit is in and the 25% has been invoiced. Only
  // a raised commitment_invoice_amount puts the 25% cell on the Payments card.
  const { error: qErr } = await sb
    .from("quotes")
    .update({
      zoho_commitment_invoice_id: "e2e-zoho-com-0001",
      commitment_invoice_provider: "zoho",
      zoho_commitment_invoice_number: r.invoiceNumber,
      commitment_invoice_amount: r.amount,
      commitment_due_date: at(7).slice(0, 10),
      commitment_paid_at: null,
      deposit_paid_at: at(-4),
    })
    .eq("id", quoteId);
  if (qErr) die(`${r.name} commitment invoice`, qErr);
  const { error: lErr } = await sb
    .from("leads")
    .update({ deposit_amount: 100, deposit_requested_at: at(-5), deposit_paid_at: at(-4) })
    .eq("id", ids.leadId);
  if (lErr) die(`${r.name} lead deposit state`, lErr);
  console.log(`seeded resend-race commitment: ${r.name} (${r.invoiceNumber}, £${r.amount} unpaid)`);
}

{
  const r = SEED.resendRaceBalance;
  const ids = await makeLead({ name: r.name, status: "completed" });
  const quoteId = await makeQuote(ids, r, {
    ref: r.quoteRef,
    total: 1350,
    status: "accepted",
    movingDate: at(-2).slice(0, 10),
    acceptedAt: at(-20),
    deposit: 100,
  });
  const { error: qErr } = await sb
    .from("quotes")
    .update({
      zoho_balance_invoice_id: "e2e-zoho-bal-0001",
      balance_invoice_provider: "zoho",
      zoho_balance_invoice_number: r.invoiceNumber,
      balance_invoice_amount: r.amount,
      deposit_paid_at: at(-19),
    })
    .eq("id", quoteId);
  if (qErr) die(`${r.name} balance invoice`, qErr);
  // Raising the final invoice sets the lead's balance amount + due date, which
  // is the Payments-card branch carrying the Final-invoice (re-send) button.
  const { error: lErr } = await sb
    .from("leads")
    .update({
      deposit_amount: 100,
      deposit_requested_at: at(-20),
      deposit_paid_at: at(-19),
      balance_amount: r.amount,
      balance_due_date: at(-2).slice(0, 10),
      balance_paid_at: null,
    })
    .eq("id", ids.leadId);
  if (lErr) die(`${r.name} lead balance state`, lErr);
  console.log(`seeded resend-race balance: ${r.name} (${r.invoiceNumber}, £${r.amount} unpaid)`);
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
    // 21 days out — comfortably OUTSIDE the ≤7-day late-booking collapse, so
    // the accept leg exercises the normal path and the £100 deposit-invoice
    // assertion stays honest (at(7) sat exactly on the collapse boundary and
    // the accept correctly froze 25% × £1,500 = £375 instead).
    moving_date: at(21).slice(0, 10),
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

// 5b. A SENT quote whose move is INSIDE the 7-day window — the late-booking path.
// Accepting it must collapse the ask to 25% AND raise the balance in the same
// pass (PRD §3.10 Addition 2), so the customer meets the whole bill once. Kept
// apart from block 5, whose 21-day date exists to prove the ordinary path is
// untouched; one quote cannot assert both.
{
  const ids = await makeLead({ name: SEED.lateQuote.name, status: "quoted" });
  const { error } = await sb.from("quotes").insert({
    quote_ref: SEED.lateQuote.quoteRef,
    client_id: ids.clientId,
    lead_id: ids.leadId,
    customer_name: SEED.lateQuote.name,
    customer_email: SINK_EMAIL,
    customer_phone: SINK_PHONE,
    subtotal: SEED.lateQuote.total,
    grand_total: SEED.lateQuote.total,
    status: "sent",
    // 3 days out. Comfortably inside the window on any run — not on the
    // boundary, which is exactly what made block 5's original at(7) ambiguous.
    moving_date: at(3).slice(0, 10),
    // The BASE deposit. Acceptance overwrites it with the collapsed ask, which
    // is the assertion: seeding 500 here would prove nothing about the rule.
    deposit_amount: 100,
    accept_token: SEED.lateQuote.acceptToken,
    email_sent_at: at(-1),
    collect_addr: "3 Late Lane, Shaftesbury, SP7 8AA",
    dest_addr: "4 Hurry Road, Gillingham, SP8 4AB",
    vat_enabled: true,
    breakdown: { vehicle: "1luton", totalMiles: 20 },
    state_blob: { seeded: MARKER },
  });
  if (error) die(`${SEED.lateQuote.name} late sent quote`, error);
  console.log(`seeded late sent quote: ${SEED.lateQuote.name} (/q/${SEED.lateQuote.acceptToken}, moving in 3 days)`);
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

// 6b. A DRAFT quote — the office quote-builder wizard opens it straight into the
// 7-step builder (status "draft" → editing). The wizard spec drives THIS stable
// row rather than the create→navigate flow (soft-nav router.push race, tracked).
{
  const ids = await makeLead({ name: SEED.draftQuote.name, status: "quoted" });
  const { error } = await sb.from("quotes").insert({
    quote_ref: SEED.draftQuote.quoteRef,
    client_id: ids.clientId,
    lead_id: ids.leadId,
    customer_name: SEED.draftQuote.name,
    customer_email: SINK_EMAIL,
    customer_phone: SINK_PHONE,
    subtotal: SEED.draftQuote.total,
    grand_total: SEED.draftQuote.total,
    status: "draft",
    moving_date: at(7).slice(0, 10),
    deposit_amount: 100,
    collect_addr: "1 Test Street, Shaftesbury, SP7 8AA",
    dest_addr: "2 Sample Road, Gillingham, SP8 4AB",
    vat_enabled: true,
    breakdown: { vehicle: "1luton", totalMiles: 20 },
    // A wizard-shaped state_blob so the builder opens PAST its forward gates: the
    // progress dots can only jump to Review once step 1 (customer name + valid
    // email) and step 2 (route dead+job miles calculated) are satisfied.
    state_blob: {
      seeded: MARKER,
      customer: { name: SEED.draftQuote.name, phone: SINK_PHONE, email: SINK_EMAIL },
      route: { deadMiles: 8, jobMiles: 20, routeLegs: [] },
    },
  });
  if (error) die(`${SEED.draftQuote.name} draft quote`, error);
  console.log(`seeded draft quote: ${SEED.draftQuote.name} (${SEED.draftQuote.quoteRef})`);
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
    items: CUBIC_SURVEY_SEED_ITEMS,
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

// 10. A SUBMITTED contractor invoice for a separate staff member — the office
//     contractor-pay review (return / mark paid). Separate staff so the crew
//     sign-gate reset never wipes it.
{
  let { data: payStaff } = await sb.from("staff").select("id").ilike("full_name", SEED.payCrew.name).maybeSingle();
  if (!payStaff) {
    const { data, error } = await sb.from("staff").insert({ full_name: SEED.payCrew.name, staff_role: "crew", is_active: true }).select("id").single();
    if (error) die("pay-crew staff", error);
    payStaff = data;
  }
  const { data: prev } = await sb.from("staff_statements").select("id").eq("staff_id", payStaff.id);
  const prevIds = (prev ?? []).map((s) => s.id);
  if (prevIds.length) {
    await sb.from("staff_statement_lines").delete().in("statement_id", prevIds);
    await sb.from("staff_statements").delete().in("id", prevIds);
  }
  const { data: stmt, error: sErr } = await sb
    .from("staff_statements")
    .insert({ staff_id: payStaff.id, ref: SEED.payCrew.statementRef, period_start: at(-7).slice(0, 10), period_end: at(-1).slice(0, 10), status: "submitted", total: 150, submitted_at: at(-1) })
    .select("id")
    .single();
  if (sErr) die("pay-crew statement", sErr);
  const { error: lErr } = await sb.from("staff_statement_lines").insert({ statement_id: stmt.id, description: "Full day — Friday", amount: 150, source: "job", sort_index: 0 });
  if (lErr) die("pay-crew line", lErr);
  console.log(`seeded submitted invoice: ${SEED.payCrew.name} (${SEED.payCrew.statementRef})`);
}

// 11. A lead with an OPEN claim — the claims working page.
{
  const ids = await makeLead({ name: SEED.claim.name, status: "completed" });
  const { error } = await sb.from("claims").insert({ lead_id: ids.leadId, client_id: ids.clientId, description: "Damaged wardrobe during the move", reported_channel: "phone" });
  if (error) die("claim", error);
  console.log(`seeded claim: ${SEED.claim.name}`);
}

// 12. A lead with a DUE (overdue) follow-up — the follow-ups queue.
{
  const ids = await makeLead({ name: SEED.followUp.name, status: "quoted" });
  const { error } = await sb.from("follow_ups").insert({ lead_id: ids.leadId, client_id: ids.clientId, reason: "quote_followup", due_at: at(-1), status: "open", source: "manual" });
  if (error) die("follow-up", error);
  console.log(`seeded follow-up: ${SEED.followUp.name}`);
}

// 13. Estimator pay unlocked — a staff row linked to the estimator profile + a
//     signed contractor agreement (self-billing is already ON from the crew reset).
{
  const { data: estProfile } = await sb.from("profiles").select("id").ilike("email", ESTIMATOR_EMAIL).maybeSingle();
  if (!estProfile) {
    console.warn(`  ⚠ no estimator profile for ${ESTIMATOR_EMAIL} — /estimator/pay unlock skipped.`);
  } else {
    let { data: estStaff } = await sb.from("staff").select("id, profile_id").ilike("email", ESTIMATOR_EMAIL).maybeSingle();
    if (!estStaff) {
      const { data, error } = await sb
        .from("staff")
        .insert({ full_name: "E2E Estimator", staff_role: "estimator", email: ESTIMATOR_EMAIL, profile_id: estProfile.id, is_active: true })
        .select("id")
        .single();
      if (error) die("estimator staff", error);
      estStaff = data;
    } else if (estStaff.profile_id !== estProfile.id) {
      await sb.from("staff").update({ profile_id: estProfile.id }).eq("id", estStaff.id);
    }
    // Clear the estimator's prior statements (lines first — FK), exactly as
    // resetCrewContractorState() does for the crew. Without this a SUBMITTED
    // invoice from an earlier run survives into the next one: its period is the
    // CURRENT week, so it sorts to the TOP of the office "To pay" list and sits
    // above the seeded review fixture, and /estimator/pay has no draft left to
    // create for "This week". Both bit us on 2026-08-21.
    const { data: estStmts } = await sb.from("staff_statements").select("id").eq("staff_id", estStaff.id);
    const estStmtIds = (estStmts ?? []).map((s) => s.id);
    if (estStmtIds.length) {
      await sb.from("staff_statement_lines").delete().in("statement_id", estStmtIds);
      await sb.from("staff_statements").delete().in("id", estStmtIds);
    }
    await sb.from("contractor_agreements").delete().eq("profile_id", estProfile.id);
    const { error: aErr } = await sb
      .from("contractor_agreements")
      .insert({ profile_id: estProfile.id, staff_id: estStaff.id, role: "estimator", agreement_version: CONTRACTOR_AGREEMENT_VERSION, signer_name: "E2E Estimator", acknowledgments: CONTRACTOR_ACKS });
    if (aErr) die("estimator agreement", aErr);
    console.log(`seeded estimator pay unlock: ${ESTIMATOR_EMAIL}`);
  }
}

// 14. Crew sign-up link (/join/<token>) switched ON with a fixed token — mirrors
//     the self_billing_enabled toggle above (a singleton business_settings flag
//     the seed enforces unconditionally, not a per-record insert). The public
//     spec POSTs its own application at this token each run.
await sb.from("business_settings").update({ staff_onboard_enabled: true, staff_onboard_token: SEED.joinApplicant.token }).eq("id", true);
console.log(`enabled crew sign-up: /join/${SEED.joinApplicant.token}`);

console.log("\n✓ E2E seed complete.");
