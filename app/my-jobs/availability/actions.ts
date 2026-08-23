"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { normalizeWorkingDays } from "@/lib/staff/availability";

const UK = "Europe/London";

const schema = z.object({
  // The <input>-free UI only ever sends real ISO days; reject anything else
  // cleanly instead of letting it reach the date column.
  date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date"),
  status: z.enum(["available", "unavailable", "clear"]),
});

export type SetMyAvailabilityInput = z.infer<typeof schema>;

/**
 * A crew member sets their OWN availability for one date. staff_id is resolved
 * from the session (never a client param) and re-checked by RLS. 'clear' removes
 * the override so the day falls back to the Mon–Fri default. Bounded to a
 * forward window — availability for a past day is meaningless.
 */
export async function setMyAvailabilityAction(input: SetMyAvailabilityInput) {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { date, status } = parsed.data;

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { ok: false as const, error: "Not signed in." };

  const { data: staffRow } = await sb
    .from("staff")
    .select("id")
    .eq("profile_id", user.id)
    .eq("is_active", true)
    .maybeSingle();
  if (!staffRow) return { ok: false as const, error: "Your login isn’t linked to a crew record yet." };

  // Only today onward, and not absurdly far out (protects the column + the UI).
  const today = new Date().toLocaleDateString("en-CA", { timeZone: UK });
  const horizon = new Date(`${today}T00:00:00Z`);
  horizon.setUTCDate(horizon.getUTCDate() + 400);
  if (date < today || date > horizon.toISOString().slice(0, 10)) {
    return { ok: false as const, error: "Pick a date within the next few months." };
  }

  if (status === "clear") {
    const { error } = await sb.from("staff_availability").delete().eq("staff_id", staffRow.id).eq("date", date);
    if (error) return { ok: false as const, error: error.message };
  } else {
    const { error } = await sb
      .from("staff_availability")
      .upsert({ staff_id: staffRow.id, date, status, note: null, created_by: user.id }, { onConflict: "staff_id,date" });
    if (error) return { ok: false as const, error: error.message };
  }

  revalidatePath("/my-jobs/availability");
  revalidatePath("/schedule");
  return { ok: true as const };
}

const workingDaysSchema = z.object({
  working_days: z.array(z.number().int().min(1).max(7)).max(7),
});

export type SetMyWorkingDaysInput = z.infer<typeof workingDaysSchema>;

/**
 * A crew member sets their OWN weekly working pattern (which weekdays they're
 * normally expected). staff_id is resolved from the session and the row is
 * confirmed to be theirs via an RLS-scoped read before writing. The write itself
 * goes through the service role and touches `working_days` ONLY — never
 * profile_id — because the 0054 staff `with check` requires an email match a
 * profile-id-linked crew member may not have, and we must not weaken that guard.
 */
export async function setMyWorkingDaysAction(input: SetMyWorkingDaysInput) {
  const parsed = workingDaysSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: "Invalid pattern." };
  const days = normalizeWorkingDays(parsed.data.working_days);

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { ok: false as const, error: "Not signed in." };

  // Ownership check via RLS-scoped read: a crew login can only see their own
  // active staff row (is_staff read policy resolves it by profile_id).
  const { data: staffRow } = await sb
    .from("staff")
    .select("id")
    .eq("profile_id", user.id)
    .eq("is_active", true)
    .maybeSingle();
  if (!staffRow) return { ok: false as const, error: "Your login isn’t linked to a crew record yet." };

  const admin = createAdminClient();
  const { error } = await admin.from("staff").update({ working_days: days }).eq("id", staffRow.id);
  if (error) return { ok: false as const, error: error.message };

  revalidatePath("/my-jobs/availability");
  revalidatePath("/schedule");
  revalidatePath("/resources");
  return { ok: true as const };
}
