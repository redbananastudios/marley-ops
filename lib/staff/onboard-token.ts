import { timingSafeEqual } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * SERVER ONLY — timing-safe compare for the crew sign-up link token.
 * Length-checked first (timingSafeEqual throws on unequal lengths); the only
 * thing a mismatch leaks is the length, which is fixed (24 random bytes,
 * base64url) and not secret.
 */
export function tokensMatch(candidate: string, expected: string): boolean {
  if (typeof candidate !== "string" || typeof expected !== "string") return false;
  if (!candidate || !expected) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Is this candidate the CURRENT crew sign-up token with the link switched on?
 * Lets the public /join form use the places autocomplete proxies: the routes
 * accept session-or-valid-token, so the Google key still never serves anonymous
 * traffic without the (revocable) link credential. Fails closed on any error.
 */
export async function isOnboardTokenValid(candidate: string | null | undefined): Promise<boolean> {
  if (!candidate || typeof candidate !== "string") return false;
  try {
    const sb = createAdminClient();
    const { data } = await sb
      .from("business_settings")
      .select("staff_onboard_enabled, staff_onboard_token")
      .eq("id", true)
      .maybeSingle();
    if (!data?.staff_onboard_enabled || !data.staff_onboard_token) return false;
    return tokensMatch(candidate, data.staff_onboard_token);
  } catch {
    return false;
  }
}
