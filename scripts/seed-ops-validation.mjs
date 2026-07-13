/**
 * OPS VALIDATION SEED — a lead/client at every pipeline stage so the whole
 * operations side can be tested end-to-end. All client contacts point at
 * Peter's own sink (peter@abacusonline.net / 07572382366) so every send is
 * safe to fire for real.
 *
 * Stages seeded:
 *   1. Two fresh website enquiries (dashboard, leads list, needs-action)
 *   2. An enquiry with a call-back follow-up due today (follow-ups page)
 *   3. survey_booked + survey appointment TOMORROW for the estimator (Luke)
 *   4. quoted + SENT quote emailed 3 days ago  → chase engine step 1 fires
 *   5. confirmed + accepted quote (deposit unpaid, accepted 2 days ago)
 *      + removal TOMORROW with Jack + Rob assigned → deposit chase,
 *      job board, crew my-jobs, crew-reminders
 *   6. completed job moved yesterday, balance outstanding (balance chase)
 *   7. declined lead with a lost reason (performance "why we lose")
 *   8. Storage: open let for a client (site + unit created if none exist)
 *
 * Staff: links/creates staff rows for Luke (estimator), Jack + Rob (crew),
 * linking staff.profile_id to their auth profile when it exists.
 *
 * Idempotent-ish: skips any lead whose name matches + notes carry the marker.
 *
 * Usage:
 *   SEED_CONFIRM=yes node --env-file=.env.production scripts/seed-ops-validation.mjs
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

const PHONE = "07572382366";
const PHONE_E164 = "+447572382366";
const EMAIL = "peter@abacusonline.net";
const MARKER = "OPS VALIDATION SEED";
const DAY = 86_400_000;

const at = (daysFromNow, hour = 10, mins = 0) => {
  const d = new Date(Date.now() + daysFromNow * DAY);
  d.setHours(hour, mins, 0, 0);
  return d.toISOString();
};
const day = (daysFromNow) => new Date(Date.now() + daysFromNow * DAY).toISOString().slice(0, 10);

async function profileByEmail(email) {
  const { data } = await sb.auth.admin.listUsers({ perPage: 200 });
  const user = data?.users?.find((u) => u.email === email);
  return user?.id ?? null;
}

async function ensureStaff(fullName, role, email) {
  const { data: existing } = await sb.from("staff").select("id").eq("full_name", fullName).maybeSingle();
  if (existing) return existing.id;
  const profileId = await profileByEmail(email);
  const { data, error } = await sb
    .from("staff")
    .insert({ full_name: fullName, staff_role: role, email, phone: PHONE, profile_id: profileId, is_active: true })
    .select("id")
    .single();
  if (error) throw new Error(`staff ${fullName}: ${error.message}`);
  console.log(`staff   ${fullName} (${role})${profileId ? " linked to login" : " — NO login profile yet"}`);
  return data.id;
}

async function makeLead(t) {
  const { data: existing } = await sb
    .from("leads")
    .select("id")
    .eq("name", t.name)
    .ilike("notes", `%${MARKER}%`)
    .maybeSingle();
  if (existing) {
    console.log(`exists  ${t.name}`);
    return null;
  }
  let client = (
    await sb.from("clients").select("id").eq("display_name", t.name).ilike("notes", `%${MARKER}%`).maybeSingle()
  ).data;
  if (!client) {
    const { data, error: cErr } = await sb
      .from("clients")
      .insert({
        display_name: t.name,
        email: t.clientContact ? EMAIL : null,
        phone_raw: t.clientContact ? PHONE : null,
        phone_e164: t.clientContact ? PHONE_E164 : null,
        postcode_home: t.from_postcode,
        notes: `${MARKER} client`,
      })
      .select("id")
      .single();
    if (cErr) throw new Error(`${t.name} client: ${cErr.message}`);
    client = data;
  }
  const { data: lead, error: lErr } = await sb
    .from("leads")
    .insert({
      client_id: client.id,
      status: t.status,
      entry_channel: t.entry_channel ?? "manual",
      source_system: "marley_ops",
      name: t.name,
      phone: PHONE,
      email: t.phoneOnly ? null : EMAIL,
      from_address: t.from_address,
      from_postcode: t.from_postcode,
      to_address: t.to_address,
      to_postcode: t.to_postcode,
      property_size: t.property_size ?? "3 bedroom",
      preferred_date: t.preferred_date ?? t.moving_date ?? null,
      notes: `${MARKER} — ${t.note}`,
      ...(t.leadExtra ?? {}),
    })
    .select("id")
    .single();
  if (lErr) throw new Error(`${t.name} lead: ${lErr.message}`);
  console.log(`seeded  ${t.name} [${t.status}] — ${t.note}`);
  return { clientId: client.id, leadId: lead.id };
}

let quoteSeq = 900;
async function makeQuote(ids, t, q) {
  const ref = `MM-TEST-${quoteSeq++}`;
  const { data, error } = await sb
    .from("quotes")
    .insert({
      quote_ref: ref,
      client_id: ids.clientId,
      lead_id: ids.leadId,
      customer_name: t.name,
      customer_email: EMAIL,
      customer_phone: PHONE,
      subtotal: q.total,
      grand_total: q.total,
      status: q.status,
      email_sent: true,
      email_sent_at: q.sentAt,
      email_send_count: 1,
      moving_date: t.moving_date ?? null,
      deposit_amount: q.deposit ?? null,
      accepted_at: q.acceptedAt ?? null,
      agreed_price: q.acceptedAt ? q.total : null,
      breakdown: { vehicle: q.vehicle ?? "1luton", totalMiles: q.miles ?? 20 },
      state_blob: { seeded: MARKER, job: { days: 1 } },
    })
    .select("id")
    .single();
  if (error) throw new Error(`${t.name} quote: ${error.message}`);
  console.log(`  quote ${ref} [${q.status}]`);
  return data.id;
}

async function makeAppt(ids, type, startsIso, hours, estimatorId, title) {
  const ends = new Date(new Date(startsIso).getTime() + hours * 3_600_000).toISOString();
  const { data, error } = await sb
    .from("appointments")
    .insert({
      appt_type: type,
      client_id: ids.clientId,
      lead_id: ids.leadId,
      estimator_id: estimatorId,
      title,
      starts_at: startsIso,
      ends_at: ends,
      status: "scheduled",
      location: "seed",
    })
    .select("id")
    .single();
  if (error) throw new Error(`${title} appt: ${error.message}`);
  return data.id;
}

// ---------------------------------------------------------------- staff first
const lukeStaff = await ensureStaff("Luke James", "estimator", "luke@marleymoves.co.uk");
const jackStaff = await ensureStaff("Jack", "crew", "jack@marleymoves.co.uk");
const robStaff = await ensureStaff("Rob", "crew", "rob@marleymoves.co.uk");
const lukeProfile = await profileByEmail("luke@marleymoves.co.uk");

// ---------------------------------------------------------------- 1. fresh enquiries
await makeLead({
  name: "Harriet Vane",
  status: "website_enquiry",
  entry_channel: "web",
  clientContact: true,
  from_address: "32 Ridgeway Road, Gillingham",
  from_postcode: "SP8 4GH",
  to_address: "18 Knole Road, Bournemouth",
  to_postcode: "BH1 4DQ",
  preferred_date: day(21),
  note: "fresh web enquiry — contact + book a survey from here",
});
await makeLead({
  name: "Peter Wimsey",
  status: "website_enquiry",
  entry_channel: "phone_google",
  from_address: "42 Princess Road, Salisbury",
  from_postcode: "SP1 2QX",
  to_address: "10 Cricklewood Lane, London",
  to_postcode: "NW2 1EX",
  property_size: "4-5 bedroom",
  preferred_date: day(28),
  note: "phone enquiry from Google — long-distance move",
});

// ---------------------------------------------------------------- 2. follow-up due today
{
  const ids = await makeLead({
    name: "Grace Holloway",
    status: "website_enquiry",
    phoneOnly: true,
    from_address: "14 Bimport, Shaftesbury",
    from_postcode: "SP7 8AY",
    to_address: "27 Cardigan Road, Leeds",
    to_postcode: "LS6 1LJ",
    note: "phone-only lead (no email) — call-back due today; chase must raise call tasks, never emails",
  });
  if (ids) {
    const { error } = await sb.from("follow_ups").insert({
      lead_id: ids.leadId,
      client_id: ids.clientId,
      reason: "no_answer",
      status: "open",
      due_at: at(0, 9, 30),
      source: "seed",
      notes: `${MARKER} — call back this morning`,
    });
    if (error) throw new Error(`follow-up: ${error.message}`);
    console.log("  follow-up due today 09:30");
  }
}

// ---------------------------------------------------------------- 3. survey booked for Luke tomorrow
{
  const ids = await makeLead({
    name: "Mary Attenbury",
    status: "survey_booked",
    clientContact: false,
    from_address: "9 Clarendon Close, Gillingham",
    from_postcode: "SP8 4NL",
    to_address: "1a Breech Close, Bourton",
    to_postcode: "SP8 5BB",
    preferred_date: day(14),
    note: "survey booked — Luke visits tomorrow 10:00; run the cubic survey (manual or AI) on this one",
  });
  if (ids) {
    await makeAppt(ids, "survey", at(1, 10), 1, lukeProfile, "Survey — Mary Attenbury");
    console.log("  survey appointment tomorrow 10:00 (Luke)");
  }
}

// ---------------------------------------------------------------- 4. sent quote, 3 days old → quote chase
{
  const ids = await makeLead({
    name: "Freddy Arbuthnot",
    status: "quoted",
    from_address: "3 Castle Street, Mere",
    from_postcode: "BA12 6JE",
    to_address: "8 George Street, Warminster",
    to_postcode: "BA12 8QA",
    property_size: "2 bedroom",
    moving_date: day(18),
    note: "quote emailed 3 days ago and unanswered — chase engine should send reminder 1 on next run",
  });
  if (ids) {
    await makeQuote(ids, { name: "Freddy Arbuthnot", moving_date: day(18) }, {
      status: "sent",
      total: 780,
      sentAt: at(-3, 11),
      vehicle: "1luton",
    });
    // status_change activity so the timeline reads sensibly
    await sb.from("activities").insert({
      lead_id: ids.leadId,
      client_id: ids.clientId,
      activity_type: "quote_sent",
      body: `${MARKER} — quote emailed`,
    });
  }
}

// ---------------------------------------------------------------- 5. booked job tomorrow, deposit unpaid, Jack+Rob assigned
{
  const ids = await makeLead({
    name: "Charles Parker",
    status: "confirmed",
    from_address: "5 Silver Street, Wincanton",
    from_postcode: "BA9 9DL",
    to_address: "22 Cheap Street, Sherborne",
    to_postcode: "DT9 3PX",
    property_size: "3 bedroom",
    moving_date: day(1),
    leadExtra: { balance_amount: 850 },
    note: "accepted 2 days ago, deposit UNPAID (deposit chase), removal tomorrow with Jack + Rob assigned (crew reminders + my-jobs + job sheet)",
  });
  if (ids) {
    await makeQuote(ids, { name: "Charles Parker", moving_date: day(1) }, {
      status: "accepted",
      total: 950,
      sentAt: at(-4, 9),
      acceptedAt: at(-2, 15),
      deposit: 100,
      vehicle: "2luton",
    });
    const apptId = await makeAppt(ids, "removal", at(1, 8), 8, lukeProfile, "Removal — Charles Parker");
    for (const staffId of [jackStaff, robStaff]) {
      const { error } = await sb.from("appointment_assignments").insert({ appointment_id: apptId, staff_id: staffId });
      if (error) throw new Error(`assignment: ${error.message}`);
    }
    console.log("  removal tomorrow 08:00, Jack + Rob assigned");
  }
}

// ---------------------------------------------------------------- 6. completed yesterday, balance outstanding
{
  const ids = await makeLead({
    name: "Reggie Fortune",
    status: "completed",
    from_address: "11 High Street, Stalbridge",
    from_postcode: "DT10 2LL",
    to_address: "4 Acreman Street, Sherborne",
    to_postcode: "DT9 3NX",
    moving_date: day(-1),
    leadExtra: { balance_amount: 620 },
    note: "moved yesterday, balance outstanding — balance chase + completion cert territory",
  });
  if (ids) {
    await makeQuote(ids, { name: "Reggie Fortune", moving_date: day(-1) }, {
      status: "accepted",
      total: 720,
      sentAt: at(-10, 9),
      acceptedAt: at(-8, 12),
      deposit: 100,
      vehicle: "1luton",
    });
    await makeAppt(ids, "removal", at(-1, 8), 8, lukeProfile, "Removal — Reggie Fortune");
  }
}

// ---------------------------------------------------------------- 7. declined
await makeLead({
  name: "Julian Freke",
  status: "declined",
  from_address: "60 Salisbury Street, Blandford",
  from_postcode: "DT11 7PR",
  to_address: "3 East Street, Wimborne",
  to_postcode: "BH21 1DX",
  leadExtra: { lost_reason: "price", lost_at: at(-2, 10) },
  note: "declined on price — feeds the lost-quotes panel",
});

// ---------------------------------------------------------------- 8. storage let
{
  let { data: unit } = await sb.from("storage_units").select("id").eq("is_active", true).limit(1).maybeSingle();
  if (!unit) {
    const { data: site, error: sErr } = await sb
      .from("storage_sites")
      .insert({ name: "Test Yard", is_active: true })
      .select("id")
      .single();
    if (sErr) throw new Error(`storage site: ${sErr.message}`);
    const { data: u, error: uErr } = await sb
      .from("storage_units")
      .insert({ site_id: site.id, code: "T1", name: "Test container", unit_type: "container_20ft", is_active: true })
      .select("id")
      .single();
    if (uErr) throw new Error(`storage unit: ${uErr.message}`);
    unit = u;
    console.log("storage site+unit created (none existed)");
  }
  const { data: existing } = await sb.from("clients").select("id").eq("display_name", "Marjorie Phelps").maybeSingle();
  if (!existing) {
    const { data: client, error } = await sb
      .from("clients")
      .insert({ display_name: "Marjorie Phelps", postcode_home: "SP8 4AB", notes: `${MARKER} storage client` })
      .select("id")
      .single();
    if (error) throw new Error(`storage client: ${error.message}`);
    const { error: letErr } = await sb.from("storage_lets").insert({
      unit_id: unit.id,
      client_id: client.id,
      start_date: day(-21),
      rate: 25,
      rate_period: "week",
      notes: `${MARKER} — open weekly let, 3 weeks in (storage billing should raise an invoice)`,
    });
    if (letErr) throw new Error(`storage let: ${letErr.message}`);
    console.log("seeded  Marjorie Phelps [storage let, 3 weeks open]");
  } else {
    console.log("exists  Marjorie Phelps");
  }
}

console.log("\nSeed complete.");
