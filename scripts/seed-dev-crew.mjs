/**
 * Dev seed (crew + diary) — local Supabase only. Adds what seed-dev.mjs doesn't:
 * a crew login, a linked staff record + van, a removal assigned to that crew
 * member today, and a survey visit for Connor today — so /my-jobs and the
 * estimator My-day page have real cards to render during UI QA.
 *
 * Run:  node --env-file=.env.local scripts/seed-dev-crew.mjs
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
if (!url.includes("127.0.0.1") && !url.includes("localhost") && !/\/\/i9(:|\/)/.test(url)) {
  console.error("Refusing to seed a non-local Supabase URL:", url);
  process.exit(1);
}

const sb = createClient(url, serviceKey, { auth: { persistSession: false } });
const DEV_PASSWORD = "MarleyOps!2026";
const CREW_EMAIL = "crew@marleymoves.test";

async function ensureUser(email, full_name, role) {
  const { data: list } = await sb.auth.admin.listUsers({ perPage: 200 });
  let user = list?.users?.find((x) => x.email === email);
  if (!user) {
    const { data, error } = await sb.auth.admin.createUser({
      email,
      password: DEV_PASSWORD,
      email_confirm: true,
      user_metadata: { full_name },
    });
    if (error) throw error;
    user = data.user;
    console.log("created user", email);
  } else {
    console.log("user exists", email);
  }
  const { error: pErr } = await sb
    .from("profiles")
    .upsert({ id: user.id, email, full_name, role, active: true });
  if (pErr) throw pErr;
  return user;
}

async function ensureStaff(full_name, email) {
  const { data: existing } = await sb.from("staff").select("id").eq("email", email).maybeSingle();
  let id = existing?.id;
  if (!id) {
    const { data, error } = await sb
      .from("staff")
      .insert({ full_name, staff_role: "crew", email, is_active: true })
      .select("id")
      .single();
    if (error) throw error;
    id = data.id;
    console.log("created staff", full_name);
  }
  // Dev pay lives in staff_pay now: £15/hr, no guarantee — so the crew invoice
  // pre-fills a rate to test hours × rate.
  const { error: payErr } = await sb.from("staff_pay").upsert({ staff_id: id, hourly_rate: 15 }, { onConflict: "staff_id" });
  if (payErr) throw payErr;
  return id;
}

async function ensureVehicle(name) {
  const { data: existing } = await sb.from("vehicles").select("id").eq("name", name).maybeSingle();
  if (existing) return existing.id;
  const { data, error } = await sb
    .from("vehicles")
    .insert({ name, vehicle_type: "luton", registration: "DEV 1", is_active: true })
    .select("id")
    .single();
  if (error) throw error;
  console.log("created vehicle", name);
  return data.id;
}

/** Today at hh:00 UK wall-clock, as an ISO instant. */
function todayAt(hourUk) {
  const ukDate = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
  // July => BST (+01:00); dev fixture only, not production date maths.
  return new Date(`${ukDate}T${String(hourUk).padStart(2, "0")}:00:00+01:00`).toISOString();
}

async function ensureAppointment({ title, appt_type, lead_id, client_id, estimator_id, startHour, endHour, location }) {
  const { data: existing } = await sb.from("appointments").select("id").eq("title", title).maybeSingle();
  if (existing) return existing.id;
  const { data, error } = await sb
    .from("appointments")
    .insert({
      title,
      appt_type,
      lead_id,
      client_id,
      estimator_id,
      starts_at: todayAt(startHour),
      ends_at: todayAt(endHour),
      status: "scheduled",
      location,
      notes: "Dev QA fixture — safe to delete",
    })
    .select("id")
    .single();
  if (error) throw error;
  console.log("created appointment", title);
  return data.id;
}

async function ensureAssignment(appointment_id, staff_id, vehicle_id) {
  const { data: existing } = await sb
    .from("appointment_assignments")
    .select("id")
    .eq("appointment_id", appointment_id)
    .maybeSingle();
  if (existing) return;
  const { error } = await sb.from("appointment_assignments").insert([
    { appointment_id, staff_id },
    ...(vehicle_id ? [{ appointment_id, vehicle_id }] : []),
  ]);
  if (error) throw error;
  console.log("assigned crew + van to appointment");
}

const crewUser = await ensureUser(CREW_EMAIL, "Jack Reed (Dev)", "crew");
const staffId = await ensureStaff("Jack Reed (Dev)", CREW_EMAIL);
// Link login → staff explicitly so /my-jobs resolves on first visit.
await sb.from("staff").update({ profile_id: crewUser.id }).eq("id", staffId);
const vanId = await ensureVehicle("Luton 1 (Dev)");

const { data: lead } = await sb
  .from("leads")
  .select("id, client_id, name, from_postcode, to_postcode")
  .eq("name", "Jane Hooper")
  .maybeSingle();
if (!lead) {
  console.error("Expected seed lead 'Jane Hooper' — run scripts/seed-dev.mjs first.");
  process.exit(1);
}

const { data: connor } = await sb.from("profiles").select("id").eq("email", "connor@marleymoves.test").single();

const removalId = await ensureAppointment({
  title: `Removal — ${lead.name}`,
  appt_type: "removal",
  lead_id: lead.id,
  client_id: lead.client_id,
  estimator_id: null,
  startHour: 9,
  endHour: 13,
  location: `${lead.from_postcode} → ${lead.to_postcode}`,
});
await ensureAssignment(removalId, staffId, vanId);

await ensureAppointment({
  title: `Survey — Priya Patel`,
  appt_type: "survey",
  lead_id: (await sb.from("leads").select("id").eq("name", "Priya Patel").single()).data.id,
  client_id: (await sb.from("leads").select("client_id").eq("name", "Priya Patel").single()).data.client_id,
  estimator_id: connor.id,
  startHour: 15,
  endHour: 16,
  location: "DT11 7SF",
});

console.log(`\nDone. Crew login: ${CREW_EMAIL} / ${DEV_PASSWORD}`);
