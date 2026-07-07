/**
 * Production user provisioning — the prod-safe counterpart of seed-dev.mjs.
 * Creates real logins (individual passwords) + profiles. Idempotent: existing
 * users are updated (name/role), never duplicated. NO sample data.
 *
 * Usage:
 *   node --env-file=.env.production scripts/create-prod-users.mjs users.json
 *   PROD_CONFIRM=yes required when the target is not local.
 *
 * users.json: [{ "email": "...", "full_name": "...", "role": "admin|estimator", "password": "..." }]
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const isLocal = url.includes("127.0.0.1") || url.includes("localhost") || url.includes("://i9");
if (!isLocal && process.env.PROD_CONFIRM !== "yes") {
  console.error(`Target is NOT local (${url}). Re-run with PROD_CONFIRM=yes to provision production users.`);
  process.exit(1);
}

const file = process.argv[2];
if (!file) {
  console.error("Usage: node scripts/create-prod-users.mjs <users.json>");
  process.exit(1);
}
const users = JSON.parse(readFileSync(file, "utf-8"));

const sb = createClient(url, serviceKey, { auth: { persistSession: false } });

for (const u of users) {
  if (!u.email || !u.full_name || !["admin", "estimator"].includes(u.role) || !u.password || u.password.length < 8) {
    console.error("Invalid user entry:", u.email ?? "(no email)");
    process.exit(1);
  }
  const { data: list } = await sb.auth.admin.listUsers({ perPage: 200 });
  let user = list?.users?.find((x) => x.email === u.email);
  if (!user) {
    const { data, error } = await sb.auth.admin.createUser({
      email: u.email,
      password: u.password,
      email_confirm: true,
      user_metadata: { full_name: u.full_name },
    });
    if (error) throw error;
    user = data.user;
    console.log("created", u.email);
  } else {
    console.log("exists ", u.email);
  }
  const { error: pErr } = await sb
    .from("profiles")
    .upsert({ id: user.id, email: u.email, full_name: u.full_name, role: u.role, active: true });
  if (pErr) throw pErr;
}
console.log(`done — ${users.length} users provisioned on ${url}`);
