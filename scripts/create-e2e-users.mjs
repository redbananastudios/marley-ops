/**
 * E2E user provisioning — creates the three role logins the Playwright suite
 * signs in as (office/admin, estimator, crew) in the TARGET auth + profiles.
 * Idempotent: existing users are updated (role/name), never duplicated.
 *
 * The crew profile must exist BEFORE scripts/seed-e2e.mjs runs — the seed links
 * the E2E crew staff row to this profile by email so /my-jobs shows the job.
 *
 * SAFETY: refuses a non-local target unless E2E_USERS_CONFIRM=yes. Passwords come
 * from env (E2E_OFFICE_PASSWORD / E2E_ESTIMATOR_PASSWORD / E2E_CREW_PASSWORD).
 *
 * Usage:
 *   node --env-file=.env.local --env-file=.env.e2e scripts/create-e2e-users.mjs
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const isLocal = url.includes("127.0.0.1") || url.includes("localhost") || url.includes("://i9");
if (!isLocal && process.env.E2E_USERS_CONFIRM !== "yes") {
  console.error(`Target is NOT local (${url}). Re-run with E2E_USERS_CONFIRM=yes to provision E2E users on a remote target.`);
  process.exit(1);
}

const USERS = [
  { key: "office", email: process.env.E2E_OFFICE_EMAIL || "e2e-office@marleymoves.test", full_name: "E2E Office", role: "admin", password: process.env.E2E_OFFICE_PASSWORD },
  { key: "estimator", email: process.env.E2E_ESTIMATOR_EMAIL || "e2e-estimator@marleymoves.test", full_name: "E2E Estimator", role: "estimator", password: process.env.E2E_ESTIMATOR_PASSWORD },
  { key: "crew", email: process.env.E2E_CREW_EMAIL || "e2e-crew@marleymoves.test", full_name: "E2E Crew", role: "crew", password: process.env.E2E_CREW_PASSWORD },
];

for (const u of USERS) {
  if (!u.password || u.password.length < 8) {
    console.error(`Set E2E_${u.key.toUpperCase()}_PASSWORD (>=8 chars) for ${u.email}`);
    process.exit(1);
  }
}

const sb = createClient(url, serviceKey, { auth: { persistSession: false } });

for (const u of USERS) {
  // listUsers is paged; the E2E targets are small so one page of 200 is ample.
  const { data: list } = await sb.auth.admin.listUsers({ perPage: 200 });
  let user = list?.users?.find((x) => x.email?.toLowerCase() === u.email.toLowerCase());
  if (!user) {
    const { data, error } = await sb.auth.admin.createUser({
      email: u.email,
      password: u.password,
      email_confirm: true,
      user_metadata: { full_name: u.full_name },
    });
    if (error) throw error;
    user = data.user;
    console.log("created", u.email, `(${u.role})`);
  } else {
    // Keep the password in lockstep with env so a rotated password still logs in.
    await sb.auth.admin.updateUserById(user.id, { password: u.password });
    console.log("exists ", u.email, `(${u.role})`);
  }
  const { error: pErr } = await sb
    .from("profiles")
    // tour_seen_at stamped so the first-login onboarding tour (driver.js) never
    // auto-starts — its overlay intercepts clicks and breaks the suite.
    .upsert({
      id: user.id,
      email: u.email,
      full_name: u.full_name,
      role: u.role,
      active: true,
      tour_seen_at: new Date().toISOString(),
    });
  if (pErr) throw pErr;
}
console.log(`\n✓ ${USERS.length} E2E users provisioned on ${url}`);
