"use server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Stamp the signed-in user's profile when they finish OR dismiss their first
 * guided tour. The flag is account-level (migration 0045) so a new device or a
 * reinstalled PWA never re-fires the auto-start — localStorage alone couldn't
 * guarantee that. Only the FIRST completion writes (the timestamp records when
 * they first saw it); manual relaunches are no-ops here.
 */
export async function markTourSeenAction(): Promise<void> {
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return;
  await createAdminClient()
    .from("profiles")
    .update({ tour_seen_at: new Date().toISOString() })
    .eq("id", user.id)
    .is("tour_seen_at", null);
}
