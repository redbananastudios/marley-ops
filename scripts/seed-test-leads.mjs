/**
 * Seed the 3 comms-testing clients + leads (Peter's own phone/email as recipients,
 * so live email/SMS sends are safe). Pair with reset-data.mjs + SANITY_SYNC_DISABLED=true
 * so no real customer data is present while testing send formats.
 *
 * All 3 contacts share one phone/email and the clients table enforces one live client
 * per phone/email, so only the first client carries them; every LEAD carries full
 * contact details (comms send to the lead's phone/email).
 *
 * Idempotent-ish: skips a lead if one with the same name + TEST marker exists.
 *
 * Usage:
 *   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... SEED_CONFIRM=yes \
 *     node scripts/seed-test-leads.mjs
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

const PHONE = "07572382366";
const PHONE_E164 = "+447572382366";
const EMAIL = "peter@abacusonline.net";

const TESTS = [
  {
    name: "John Farnell",
    withContactOnClient: true,
    from_address: "32 Ridgeway Road, Gillingham",
    from_postcode: "SP8 4GH",
    to_address: "18 Knole Road, Bournemouth",
    to_postcode: "BH1 4DQ",
    spec: "1 x Luton Van + Full pack",
  },
  {
    name: "William Costa",
    withContactOnClient: false,
    from_address: "42 Princess Road, London",
    from_postcode: "NW6 5QX",
    to_address: "10 Cricklewood Lane, London",
    to_postcode: "NW2 1EX",
    spec: "3 x Luton Vans",
  },
  {
    name: "Anna Braile",
    withContactOnClient: false,
    from_address: "9 Clarendon Close, Gillingham",
    from_postcode: "SP8 4NL",
    to_address: "1a Breech Close, Bourton",
    to_postcode: "SP8 5BB",
    spec: "2 x Luton Van + Fragile pack",
  },
];

const sb = createClient(url, serviceKey, { auth: { persistSession: false } });

for (const t of TESTS) {
  const { data: existing } = await sb
    .from("leads")
    .select("id")
    .eq("name", t.name)
    .ilike("notes", "%TEST LEAD%")
    .maybeSingle();
  if (existing) {
    console.log(`exists  ${t.name}`);
    continue;
  }

  const { data: client, error: cErr } = await sb
    .from("clients")
    .insert({
      display_name: t.name,
      email: t.withContactOnClient ? EMAIL : null,
      phone_raw: t.withContactOnClient ? PHONE : null,
      phone_e164: t.withContactOnClient ? PHONE_E164 : null,
      postcode_home: t.from_postcode,
      notes: "TEST CLIENT — comms format testing, delete before backfill",
    })
    .select("id")
    .single();
  if (cErr) {
    console.error(`${t.name}: client insert failed — ${cErr.message}`);
    process.exit(1);
  }

  const { error: lErr } = await sb.from("leads").insert({
    client_id: client.id,
    status: "website_enquiry",
    entry_channel: "manual",
    source_system: "marley_ops",
    name: t.name,
    phone: PHONE,
    email: EMAIL,
    from_address: t.from_address,
    from_postcode: t.from_postcode,
    to_address: t.to_address,
    to_postcode: t.to_postcode,
    property_size: "3 bedroom",
    notes: `TEST LEAD — comms format testing. Quote spec: ${t.spec}`,
  });
  if (lErr) {
    console.error(`${t.name}: lead insert failed — ${lErr.message}`);
    process.exit(1);
  }
  console.log(`seeded  ${t.name} (${t.spec})`);
}
console.log("done");
