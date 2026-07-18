import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Is crew self-billing switched on? Read via the SERVICE ROLE because
 * business_settings' read RLS is `is_office()` — a crew login can't see the row,
 * so the crew-facing surfaces (My pay page + pay actions) must read this single
 * non-sensitive boolean out-of-band, or the feature would be permanently hidden
 * from crew even when enabled. Office surfaces read business_settings directly.
 */
export async function isSelfBillingEnabled(): Promise<boolean> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("business_settings")
    .select("self_billing_enabled")
    .eq("id", true)
    .maybeSingle();
  return data?.self_billing_enabled === true;
}
