import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/database.types";

export type Profile = Database["public"]["Tables"]["profiles"]["Row"];
export type Role = Database["public"]["Enums"]["user_role"];

/** The signed-in user's profile (id, role, name) or null. Server-only. */
export const getSessionProfile = cache(async (): Promise<Profile | null> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data } = await supabase.from("profiles").select("*").eq("id", user.id).single();
  // A deactivated account may retain a valid auth refresh token. Treat it as
  // signed out at the shared profile boundary so every page/action using this
  // helper fails closed without having to remember a second active check.
  return data?.active ? data : null;
});

/**
 * Admin-only page gate. Call as the FIRST statement of any office page that is
 * absent from `ESTIMATOR_NAV` — customer PII, other people's pay, company-wide
 * money, signed documents, the ops dashboard.
 *
 * A hidden nav link is not access control. `app/(dashboard)/layout.tsx` bounces
 * only `crew`, so without this an estimator who types the URL (or follows a
 * stale bookmark or a shared link) gets the full unredacted page. That was true
 * of seven routes in production until 2026-08-27 (QA-20260827-01), which is why
 * this lives in one helper rather than seven copied conditionals: a gate that
 * has to be remembered per page is a gate that will be forgotten on page eight.
 *
 * Each role is sent somewhere it can actually work rather than to a dead end,
 * and the redirect throws, so callers may treat the return as a present admin.
 */
export async function requireAdminPage(): Promise<Profile> {
  const profile = await getSessionProfile();
  // Matches the layout's own handling: a live session whose profile is missing
  // or deactivated must be signed out, never bounced to /login (that pair
  // redirect-loops).
  if (!profile) redirect("/auth/stale");
  if (profile.role === "crew") redirect("/my-jobs");
  if (profile.role !== "admin") redirect("/estimator");
  return profile;
}
