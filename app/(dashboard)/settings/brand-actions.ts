"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { sanitizeBrandUpdate, type BrandUpdateInput } from "@/lib/brand-update";

async function requireAdmin() {
  // Active-aware gate, mirroring settings/actions.ts: getSessionProfile treats
  // a deactivated account as signed out, so a deactivated admin holding a live
  // token fails closed here too. Writes still go through the RLS `sb` client
  // (is_admin() on brands writes is the primary backstop, PRD §3.1); this
  // check exists so a non-admin gets a clean refusal instead of a silent
  // 0-row update.
  const profile = await getSessionProfile();
  const sb = await createClient();
  if (!profile) return { sb, error: "Not signed in." as const };
  if (profile.role !== "admin") return { sb, error: "Only admins can change this." as const };
  return { sb, error: null };
}

/**
 * Update one brand's SAFE display fields (admin only) — Settings › Brands.
 *
 * The safe-field set is enforced SERVER-SIDE by sanitizeBrandUpdate's
 * hardcoded whitelist (lib/brand-update.ts): phone, address, review/terms/logo
 * URLs, the two colours, and the card-payments switch. Everything structural —
 * slug, ref_prefix, active, name, email identities, template ids — is stripped
 * if smuggled and changes by migration/runbook only: a changed ref prefix
 * breaks bank reconciliation on refs already issued, and activation IS the
 * single-brand-invariant switch (PRD §1), never a UI action.
 */
export async function updateBrandAction(slug: string, input: BrandUpdateInput) {
  // Validate first, auth second — mirrors updateSettingsAction's shape. The
  // slug is only ever the row FILTER; it is never part of the update payload.
  if (typeof slug !== "string" || slug.trim() === "") {
    return { ok: false as const, error: "Invalid brand." };
  }
  // The slug also tells the sanitizer WHICH row this is: for the default
  // brand it drops card_payments_enabled entirely (the per-brand card flag is
  // deliberately dead there — QA-20260826-07 remainder — so persisting it
  // would only manufacture a false state for the Settings UI to assert).
  const sanitized = sanitizeBrandUpdate(input, slug);
  if (!sanitized.ok) return { ok: false as const, error: sanitized.error };

  const { sb, error } = await requireAdmin();
  if (error) return { ok: false as const, error };

  const { data, error: dbErr } = await sb
    .from("brands")
    .update(sanitized.update)
    .eq("slug", slug)
    .select("slug");
  if (dbErr) return { ok: false as const, error: dbErr.message };
  if (!data || data.length === 0) {
    // 0 rows matched: unknown slug, or RLS filtered the write (role changed
    // under a stale session). Surfacing it is the point — a save that reports
    // success while writing nothing is the lying-UI class this codebase hunts.
    return {
      ok: false as const,
      error: "Nothing was saved — the brand row was not found or you no longer have admin access. Reload and try again.",
    };
  }

  revalidatePath("/settings");
  return { ok: true as const };
}
