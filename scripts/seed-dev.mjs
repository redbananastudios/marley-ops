/**
 * Dev seed — local Supabase only. Creates the four users, sets roles, and inserts
 * a few sample leads across sources so the UI has data to build against.
 *
 * Run:  node --env-file=.env.local scripts/seed-dev.mjs
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
if (!url.includes("127.0.0.1") && !url.includes("localhost")) {
  console.error("Refusing to seed a non-local Supabase URL:", url);
  process.exit(1);
}

const sb = createClient(url, serviceKey, { auth: { persistSession: false } });
const DEV_PASSWORD = "MarleyOps!2026";

const USERS = [
  { email: "connor@marleymoves.test", full_name: "Connor Wass", role: "estimator" },
  { email: "luke@marleymoves.test", full_name: "Luke James", role: "estimator" },
  { email: "peter@marleymoves.test", full_name: "Peter Farrell", role: "admin" },
  { email: "bex@marleymoves.test", full_name: "Bex", role: "admin" },
];

async function ensureUser(u) {
  const { data: list } = await sb.auth.admin.listUsers({ perPage: 200 });
  let user = list?.users?.find((x) => x.email === u.email);
  if (!user) {
    const { data, error } = await sb.auth.admin.createUser({
      email: u.email,
      password: DEV_PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: u.full_name },
    });
    if (error) throw error;
    user = data.user;
    console.log("created user", u.email);
  } else {
    console.log("user exists", u.email);
  }
  // ensure profile role/name (trigger creates estimator by default)
  const { error: pErr } = await sb
    .from("profiles")
    .upsert({ id: user.id, email: u.email, full_name: u.full_name, role: u.role, active: true });
  if (pErr) throw pErr;
  return user;
}

async function seedLeads(estimatorId) {
  const { count } = await sb.from("leads").select("*", { count: "exact", head: true });
  if (count && count > 0) {
    console.log(`leads already present (${count}) — skipping sample leads`);
    return;
  }
  const samples = [
    {
      client: { display_name: "Jane Hooper", email: "jane.hooper@example.com", phone_raw: "07911 222333", phone_e164: "+447911222333", postcode_home: "SP7 8AA" },
      lead: {
        status: "website_enquiry", entry_channel: "web", source_system: "website", source_form: "homepage_hero",
        name: "Jane Hooper", phone: "+447911222333", email: "jane.hooper@example.com",
        from_postcode: "SP7 8AA", to_postcode: "BA12 6DT", property_size: "3 bed", services: ["packing"],
        gclid: "Cj0KCQ-demo-gclid-001", utm_source: "google", utm_medium: "cpc", utm_campaign: "house-removals",
        landing_url: "https://marleymoves.co.uk/go/house-removals/?area=Shaftesbury",
      },
    },
    {
      client: { display_name: "Mark Stevens", email: null, phone_raw: "07700 900111", phone_e164: "+447700900111", postcode_home: "BA9 9AB" },
      lead: {
        status: "survey_booked", entry_channel: "phone_google", source_system: "marley_ops", referrer_answer: "Found you on Google",
        name: "Mark Stevens", phone: "+447700900111", from_postcode: "BA9 9AB", to_postcode: "DT9 3NG", property_size: "4 bed",
      },
    },
    {
      client: { display_name: "Priya Patel", email: "priya@example.com", phone_raw: "07555 010101", phone_e164: "+447555010101", postcode_home: "DT11 7SF" },
      lead: {
        status: "quoted", entry_channel: "referral", source_system: "marley_ops", referrer_answer: "Referred by the Hoopers",
        name: "Priya Patel", phone: "+447555010101", email: "priya@example.com", from_postcode: "DT11 7SF", to_postcode: "PR9 8NL", property_size: "2 bed",
      },
    },
  ];
  for (const s of samples) {
    const { data: client, error: cErr } = await sb.from("clients").insert(s.client).select("id").single();
    if (cErr) throw cErr;
    const { error: lErr } = await sb.from("leads").insert({ ...s.lead, client_id: client.id, estimator_id: estimatorId });
    if (lErr) throw lErr;
    console.log("seeded lead:", s.lead.name);
  }
}

const users = [];
for (const u of USERS) users.push(await ensureUser(u));
const connor = users[0];
await seedLeads(connor.id);
console.log(`\nDone. Dev login password for all users: ${DEV_PASSWORD}`);
