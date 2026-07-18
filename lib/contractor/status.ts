import type { createClient } from "@/lib/supabase/server";
import { CONTRACTOR_AGREEMENT_VERSION } from "./agreement";

/**
 * Has this user signed the CURRENT contractor-agreement version? RLS lets a user
 * read their own contractor_agreements rows, so the caller's own session client
 * is enough (no service role). A signed CURRENT version is the per-user gate for
 * contractor invoicing.
 */
export async function hasSignedCurrentAgreement(
  sb: Awaited<ReturnType<typeof createClient>>,
  profileId: string,
): Promise<boolean> {
  const { data } = await sb
    .from("contractor_agreements")
    .select("id")
    .eq("profile_id", profileId)
    .eq("agreement_version", CONTRACTOR_AGREEMENT_VERSION)
    .maybeSingle();
  return !!data;
}
