import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Clears a stale-but-valid auth session whose profile is missing or
 * deactivated. Without this, such a session loops forever: the app shells
 * bounce a null profile to /login, and the proxy bounces any authenticated
 * request on /login back to "/" (ERR_TOO_MANY_REDIRECTS — hit live at go-live
 * by devices still carrying deactivated test-login cookies). Signing out here
 * breaks the cycle so /login renders with no session.
 */
export async function GET() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  // Absolute base from config, NOT request.url — behind the reverse proxy the
  // request host is the container bind (0.0.0.0:3000), which browsers reject
  // as a redirect target (same pattern as /api/card/return).
  const base = (process.env.NEXT_PUBLIC_APP_URL || "https://ops.marleymoves.co.uk").replace(/\/$/, "");
  return NextResponse.redirect(`${base}/login`, 303);
}
