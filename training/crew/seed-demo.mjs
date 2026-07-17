/**
 * Seed (or clean up) the LOCAL demo dataset the crew training video films
 * against: a friendly fake customer with a confirmed move today, an accepted
 * quote with a real inventory, a cubic-survey item list (one "not moving"
 * line), and the crew login assigned with a van. Local Supabase ONLY — the
 * guard refuses any other URL. Never run against prod.
 *
 * Run from training/:  node --env-file=../.env.local crew/seed-demo.mjs
 * Cleanup:             node --env-file=../.env.local crew/seed-demo.mjs --cleanup
 *
 * Prereqs: the app's dev seeds (scripts/seed-dev.mjs + scripts/seed-dev-crew.mjs)
 * have run at least once, so the crew login + staff + van exist.
 */
import { createClient } from "@supabase/supabase-js";
import { CREW_LOGIN, DEMO_CUSTOMER, DEMO_QUOTE_REF, DEMO_TAG, localGuard } from "./demo.config.mjs";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (run with --env-file=../.env.local)");
  process.exit(1);
}
localGuard(url);

const sb = createClient(url, serviceKey, { auth: { persistSession: false } });
const cleanup = process.argv.includes("--cleanup");

function todayUk() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
}
/** Today at hh:00 UK wall-clock as an ISO instant (BST fixture maths, dev only). */
function todayAt(hourUk) {
  return new Date(`${todayUk()}T${String(hourUk).padStart(2, "0")}:00:00+01:00`).toISOString();
}

async function findDemo() {
  const { data: lead } = await sb
    .from("leads")
    .select("id, client_id")
    .eq("name", DEMO_CUSTOMER.name)
    .eq("email", DEMO_CUSTOMER.email)
    .maybeSingle();
  return lead ?? null;
}

async function doCleanup() {
  const lead = await findDemo();
  if (!lead) {
    console.log("cleanup: no demo lead found — nothing to do");
    return;
  }
  const left = [];
  const del = async (table, col, val) => {
    const { error } = await sb.from(table).delete().eq(col, val);
    if (error) left.push(`${table}: ${error.message}`);
  };

  const { data: appts } = await sb.from("appointments").select("id").eq("lead_id", lead.id);
  for (const a of appts ?? []) await del("appointment_assignments", "appointment_id", a.id);
  await del("job_notes", "lead_id", lead.id);
  await del("signatures", "lead_id", lead.id);
  await del("cubic_surveys", "lead_id", lead.id);
  await del("appointments", "lead_id", lead.id);
  await del("quotes", "lead_id", lead.id);
  await del("activities", "lead_id", lead.id);
  await del("follow_ups", "lead_id", lead.id);
  await del("leads", "id", lead.id);
  if (lead.client_id) await del("clients", "id", lead.client_id);

  if (left.length) {
    console.log("cleanup finished with leftovers (fine locally, but note them):");
    for (const l of left) console.log("  -", l);
  } else {
    console.log("cleanup: demo lead, client, quote, survey, appointment + assignments all removed");
  }
}

async function doSeed() {
  // 1. Crew login + staff + van must already exist (app dev seeds).
  const { data: profile } = await sb.from("profiles").select("id").eq("email", CREW_LOGIN.email).maybeSingle();
  if (!profile) {
    console.error(`Crew login ${CREW_LOGIN.email} not found — run scripts/seed-dev.mjs + scripts/seed-dev-crew.mjs first.`);
    process.exit(1);
  }
  const { data: staff } = await sb
    .from("staff")
    .select("id")
    .eq("profile_id", profile.id)
    .eq("is_active", true)
    .maybeSingle();
  if (!staff) {
    console.error("Crew staff record not found — run scripts/seed-dev-crew.mjs first.");
    process.exit(1);
  }
  const { data: van } = await sb.from("vehicles").select("id").eq("is_active", true).limit(1).maybeSingle();
  // A second pair of hands on the card ("With Jack") if another crew staff exists.
  const { data: mate } = await sb
    .from("staff")
    .select("id")
    .eq("staff_role", "crew")
    .eq("is_active", true)
    .neq("id", staff.id)
    .limit(1)
    .maybeSingle();

  if (await findDemo()) {
    console.log("demo lead already present — reseeding on top is not supported; run --cleanup first");
    process.exit(1);
  }

  // 2. Client + lead (confirmed move — deposit paid in the story).
  const { data: client, error: cErr } = await sb
    .from("clients")
    .insert({
      display_name: DEMO_CUSTOMER.name,
      email: DEMO_CUSTOMER.email,
      phone_raw: DEMO_CUSTOMER.phoneRaw,
      phone_e164: DEMO_CUSTOMER.phoneE164,
      postcode_home: DEMO_CUSTOMER.fromPostcode,
    })
    .select("id")
    .single();
  if (cErr) throw cErr;

  const { data: lead, error: lErr } = await sb
    .from("leads")
    .insert({
      client_id: client.id,
      status: "confirmed",
      entry_channel: "phone_google",
      source_system: "marley_ops",
      name: DEMO_CUSTOMER.name,
      email: DEMO_CUSTOMER.email,
      phone: DEMO_CUSTOMER.phoneE164,
      from_address: DEMO_CUSTOMER.fromAddress,
      from_postcode: DEMO_CUSTOMER.fromPostcode,
      to_address: DEMO_CUSTOMER.toAddress,
      to_postcode: DEMO_CUSTOMER.toPostcode,
      property_size: "3 bed",
      notes: DEMO_TAG,
    })
    .select("id")
    .single();
  if (lErr) throw lErr;

  // 3. Accepted quote — the wizard state_blob drives the crew job page's
  // vehicle/packing labels, inventory and access notes (all price-free there).
  const stateBlob = {
    customer: { name: DEMO_CUSTOMER.name, phone: DEMO_CUSTOMER.phoneRaw, email: DEMO_CUSTOMER.email },
    job: {
      collectAddr: `${DEMO_CUSTOMER.fromAddress}, ${DEMO_CUSTOMER.fromPostcode}`,
      destAddr: `${DEMO_CUSTOMER.toAddress}, ${DEMO_CUSTOMER.toPostcode}`,
      collectAddress: { line1: DEMO_CUSTOMER.fromAddress, town: "Shaftesbury", postcode: DEMO_CUSTOMER.fromPostcode },
      destAddress: { line1: DEMO_CUSTOMER.toAddress, town: "Gillingham", postcode: DEMO_CUSTOMER.toPostcode },
      moveDate: todayUk(),
      days: 1,
    },
    vehicle: "1luton",
    sevenFiveT: 0,
    transitVans: 0,
    packing: "fragile",
    collect: { type: "house", lift: "no", floor: "ground", accessM: 15 },
    dest: { type: "house", lift: "no", floor: "ground", accessM: 0 },
    items: { wardrobeBoxes: 8, boxesBefore: 25, mirrorsQty: 4, mattressDouble: 2, covTV: 2, cov3Seater: 1 },
    survey: {
      accessNotes: "Narrow lane at the collection side. Park on the drive.",
      largeItemsNotes: "American fridge freezer. Two person lift.",
    },
    review: { discount: 0, quoteNotes: "Keys collected from the agent at 9am." },
  };
  const { data: quote, error: qErr } = await sb
    .from("quotes")
    .insert({
      quote_ref: DEMO_QUOTE_REF,
      client_id: client.id,
      lead_id: lead.id,
      customer_name: DEMO_CUSTOMER.name,
      customer_email: DEMO_CUSTOMER.email,
      customer_phone: DEMO_CUSTOMER.phoneRaw,
      collect_addr: stateBlob.job.collectAddr,
      dest_addr: stateBlob.job.destAddr,
      moving_date: todayUk(),
      vehicle: "1luton",
      packing: "fragile",
      status: "accepted",
      accepted_at: new Date().toISOString(),
      accepted_name: DEMO_CUSTOMER.name,
      state_blob: stateBlob,
    })
    .select("id")
    .single();
  if (qErr) throw qErr;

  // 4. Cubic-survey inventory — room-grouped list on the crew page, with one
  // "Not moving — leave in place" line (the manual's part-2 warning).
  const line = (room, title, unitFt3, qty = 1, flags = undefined) => ({
    id: crypto.randomUUID(),
    key: `custom:${crypto.randomUUID()}`,
    title,
    category: "custom",
    qty,
    unitFt3,
    room,
    ...(flags ? { flags } : {}),
  });
  const items = [
    line("Living room", "3 seater sofa", 45, 1, { fragile: true }),
    line("Living room", "TV (55 inch)", 8, 1),
    line("Living room", "Bookcase", 20, 2, { dismantle: true }),
    line("Kitchen", "American fridge freezer", 40, 1),
    line("Kitchen", "Dining table", 30, 1, { dismantle: true }),
    line("Kitchen", "Dining chairs", 6, 4),
    line("Bedroom", "Double bed + mattress", 50, 1, { dismantle: true }),
    line("Bedroom", "Double wardrobe", 40, 1),
    line("Garden", "Upright piano", 60, 1, { notMoving: true }),
  ];
  const totalFt3 = items.filter((i) => !i.flags?.notMoving).reduce((s, i) => s + i.unitFt3 * i.qty, 0);
  const { error: cuErr } = await sb.from("cubic_surveys").insert({
    lead_id: lead.id,
    client_id: client.id,
    items,
    total_ft3: totalFt3,
    status: "complete",
    notes: DEMO_TAG,
  });
  if (cuErr) throw cuErr;

  // 5. Today's removal, assigned to the crew login + van (+ a mate if present).
  const { data: appt, error: aErr } = await sb
    .from("appointments")
    .insert({
      title: `Removal — ${DEMO_CUSTOMER.name}`,
      appt_type: "removal",
      lead_id: lead.id,
      client_id: client.id,
      starts_at: todayAt(9),
      ends_at: todayAt(14),
      status: "scheduled",
      location: `${DEMO_CUSTOMER.fromPostcode} → ${DEMO_CUSTOMER.toPostcode}`,
      notes: DEMO_TAG,
    })
    .select("id")
    .single();
  if (aErr) throw aErr;

  const assigns = [{ appointment_id: appt.id, staff_id: staff.id }];
  if (mate) assigns.push({ appointment_id: appt.id, staff_id: mate.id });
  if (van) assigns.push({ appointment_id: appt.id, vehicle_id: van.id });
  const { error: asErr } = await sb.from("appointment_assignments").insert(assigns);
  if (asErr) throw asErr;

  // NOTE: no contract signature row is seeded — the job starts UNSIGNED so the
  // yellow banner shows. record.ts inserts/removes the signature per take.
  console.log(`seeded: ${DEMO_CUSTOMER.name} (lead ${lead.id})`);
  console.log(`  quote ${DEMO_QUOTE_REF} accepted, UNSIGNED (yellow banner will show)`);
  console.log(`  removal today 09:00–14:00, appointment ${appt.id}`);
  console.log(`  crew login: ${CREW_LOGIN.email}`);
}

if (cleanup) await doCleanup();
else await doSeed();
