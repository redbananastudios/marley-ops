import { createClient } from "@supabase/supabase-js";

/**
 * Service-role brand-row helpers for the single-brand parity project
 * (multi-brand PRD §6 addition 1, §11.10).
 *
 * Staging deliberately seeds Pitmans `active = true` so every gate review shows
 * the brand work the moment Peter opens the URL. Parity therefore cannot be
 * asserted in staging's default state: the parity specs flip the Pitmans row
 * off, prove the brand UI is gone, and flip it back. That is a mutation of
 * GLOBAL state on a shared environment, so these helpers carry BOTH prod
 * refusals the rest of the suite has — the APP-host gate from
 * `global-setup.ts` and the DATABASE-host gate from `db.ts`. Neither half of a
 * misconfigured run can reach production.
 *
 * Writes prove themselves. A Supabase `update` that matches no row returns NO
 * error, and a silent no-op here is the worst outcome in both directions:
 * deactivation that didn't take makes the parity run assert against a
 * still-multi-brand UI (a pass that proves nothing), and reactivation that
 * didn't take leaves staging single-brand, making every later gate look
 * broken (#71 is the standing lesson about teardowns that fail quietly). So
 * `setBrandActive` returns the row from the UPDATE itself via `.select()` and
 * throws when zero rows matched or the value read back wrong.
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

/** EXACT host match, mirroring global-setup: `staging.ops.marleymoves.co.uk`
 *  contains the prod host as a substring, so `.includes()` would wrongly
 *  refuse staging. */
const PROD_APP_HOSTS = ["ops.marleymoves.co.uk", "www.ops.marleymoves.co.uk"];

function db() {
  if (!url || !serviceKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are required to flip a brand row.",
    );
  }
  // Same DATABASE-host refusal as e2e/fixtures/db.ts.
  if (url.includes("supabase.redbananastudios.com")) {
    throw new Error(`Parity fixtures refuse to touch the PRODUCTION Supabase host (${url}).`);
  }
  // Same APP-host refusal as global-setup: belt and braces — a run pointed at
  // prod's app but staging's DB (or vice versa) is refused either way.
  const base = process.env.E2E_BASE_URL || "http://localhost:3015";
  const host = (() => {
    try {
      return new URL(base).host;
    } catch {
      return base;
    }
  })();
  if (PROD_APP_HOSTS.some((h) => host === h)) {
    throw new Error(`Parity fixtures refuse to run against a production app host (${host}).`);
  }
  return createClient(url, serviceKey, { auth: { persistSession: false } });
}

/**
 * Flip one brand row's `active` flag and prove the write took. Throws when the
 * slug matched nothing (missing seed) or the returned value is not what was
 * asked for — see the header for why a silent no-op is the dangerous outcome.
 */
export async function setBrandActive(slug: string, active: boolean): Promise<void> {
  const { data, error } = await db()
    .from("brands")
    .update({ active })
    .eq("slug", slug)
    .select("slug, active");
  if (error) {
    throw new Error(`Setting brands.${slug}.active=${active} failed: ${error.message}`);
  }
  if (!data?.length) {
    throw new Error(
      `Setting brands.${slug}.active=${active} matched NO row — is the '${slug}' brand seeded on this target?`,
    );
  }
  const row = data[0] as { slug: string; active: boolean };
  if (row.active !== active) {
    throw new Error(`brands.${slug}.active read back as ${row.active}, expected ${active}.`);
  }
}

/**
 * Read one brand row's `active` flag straight from the database. Throws on a
 * missing row rather than returning a default — the parity teardown must be
 * able to tell "inactive" apart from "could not check" ("I could not check"
 * must never render as "nothing to report").
 */
export async function getBrandActive(slug: string): Promise<boolean> {
  const { data, error } = await db().from("brands").select("active").eq("slug", slug).maybeSingle();
  if (error) {
    throw new Error(`Reading brands.${slug}.active failed: ${error.message}`);
  }
  if (!data) {
    throw new Error(`No brands row for slug '${slug}' — cannot report an active state it never read.`);
  }
  return (data as { active: boolean }).active === true;
}

/**
 * Read one brand row's `terms_url` straight from the database. Same
 * missing-row contract as `getBrandActive` above — a spec that restores this
 * value afterward needs to know it genuinely read the prior value, not a
 * silently-assumed default.
 */
export async function getBrandTermsUrl(slug: string): Promise<string | null> {
  const { data, error } = await db().from("brands").select("terms_url").eq("slug", slug).maybeSingle();
  if (error) {
    throw new Error(`Reading brands.${slug}.terms_url failed: ${error.message}`);
  }
  if (!data) {
    throw new Error(`No brands row for slug '${slug}' — cannot report a terms_url it never read.`);
  }
  return (data as { terms_url: string | null }).terms_url;
}

/**
 * Flip one brand row's `terms_url` and prove the write took, same no-op
 * contract as `setBrandActive` above (a safe, settings-editable field —
 * Settings > Brands' "Terms link" — never schema/payments/comms/auth).
 */
export async function setBrandTermsUrl(slug: string, termsUrl: string | null): Promise<void> {
  const { data, error } = await db().from("brands").update({ terms_url: termsUrl }).eq("slug", slug).select("slug, terms_url");
  if (error) {
    throw new Error(`Setting brands.${slug}.terms_url=${termsUrl} failed: ${error.message}`);
  }
  if (!data?.length) {
    throw new Error(
      `Setting brands.${slug}.terms_url=${termsUrl} matched NO row — is the '${slug}' brand seeded on this target?`,
    );
  }
  const row = data[0] as { slug: string; terms_url: string | null };
  if (row.terms_url !== termsUrl) {
    throw new Error(`brands.${slug}.terms_url read back as ${row.terms_url}, expected ${termsUrl}.`);
  }
}
