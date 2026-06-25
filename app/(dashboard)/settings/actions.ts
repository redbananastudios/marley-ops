"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

const num = z.coerce.number().nonnegative("Must be 0 or more");

const settingsSchema = z.object({
  estimatorFee: num,
  costFuelPerMile: num,
  costLabourPerDay: num,
  costBox: num,
  costVanDay: num,
  cost75t: num,
  costMisc: num,
  vatDefault: z.boolean(),
});

export type SettingsInput = z.infer<typeof settingsSchema>;

/** Update the business settings (admin only). RLS also enforces this, but we check
 *  explicitly so a non-admin gets a clear message rather than a silent no-op. */
export async function updateSettingsAction(input: SettingsInput) {
  const parsed = settingsSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { ok: false as const, error: "Not signed in." };
  const { data: prof } = await sb.from("profiles").select("role").eq("id", user.id).single();
  if (prof?.role !== "admin") return { ok: false as const, error: "Only admins can change rates." };

  const v = parsed.data;
  const { error } = await sb
    .from("business_settings")
    .update({
      estimator_fee: v.estimatorFee,
      cost_fuel_per_mile: v.costFuelPerMile,
      cost_labour_per_day: v.costLabourPerDay,
      cost_box: v.costBox,
      cost_van_day: v.costVanDay,
      cost_75t: v.cost75t,
      cost_misc: v.costMisc,
      vat_default: v.vatDefault,
    })
    .eq("id", true);
  if (error) return { ok: false as const, error: error.message };

  revalidatePath("/settings");
  revalidatePath("/performance");
  revalidatePath("/");
  return { ok: true as const };
}
