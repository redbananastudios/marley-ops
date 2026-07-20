import { cache } from "react";
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
