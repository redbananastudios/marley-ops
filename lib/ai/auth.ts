import "server-only";

import { createClient } from "@/lib/supabase/server";

export interface OfficeProfile {
  id: string;
  fullName: string;
  /** Login email — doubles as the member's sending identity when it's on the
   *  company domain (lib/comms/sender.ts ownerFrom). */
  email: string | null;
  role: "admin" | "estimator";
  accessToken: string;
}

/** Active admin/estimator gate for every AI action and route. Crew is denied. */
export async function requireOfficeProfile(): Promise<OfficeProfile | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("id, full_name, email, role, active")
    .eq("id", user.id)
    .maybeSingle();
  if (
    !profile?.active ||
    (profile.role !== "admin" && profile.role !== "estimator")
  ) {
    return null;
  }

  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) return null;

  return {
    id: profile.id,
    fullName: profile.full_name,
    email: profile.email ?? null,
    role: profile.role,
    accessToken: session.access_token,
  };
}
