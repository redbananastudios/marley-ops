"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { VEHICLE_KEYS } from "@/lib/quote/constants";
import { toPricingConfig, type EditablePricing } from "@/lib/quote/pricing-config";

async function requireAdmin() {
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { sb, error: "Not signed in." as const };
  const { data: prof } = await sb.from("profiles").select("role").eq("id", user.id).single();
  if (prof?.role !== "admin") return { sb, error: "Only admins can change this." as const };
  return { sb, error: null };
}

const money = z.coerce.number().nonnegative();
const tierPack = z.object({ full: money, fragile: money });
const pricingSchema = z.object({
  base: z.record(z.string(), money),
  pack: z.record(z.string(), tierPack),
  addon75Base: money,
  addon75Pack: tierPack,
  addonTransitBase: money,
  extraDayRate: money,
});

/** Save the editable quote prices (admin only). Validated + normalised before write. */
export async function savePricingAction(input: EditablePricing) {
  const parsed = pricingSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues[0]?.message ?? "Invalid prices" };
  }
  const { sb, error } = await requireAdmin();
  if (error) return { ok: false as const, error };

  // Normalise to the canonical shape (owner=0 enforced) before persisting.
  const config = toPricingConfig(parsed.data as EditablePricing);
  const stored: EditablePricing = {
    base: Object.fromEntries(VEHICLE_KEYS.map((k) => [k, config.base[k]])) as EditablePricing["base"],
    pack: Object.fromEntries(
      VEHICLE_KEYS.map((k) => [k, { full: config.pack[k].full, fragile: config.pack[k].fragile }]),
    ) as EditablePricing["pack"],
    addon75Base: config.addon75Base,
    addon75Pack: { full: config.addon75Pack.full, fragile: config.addon75Pack.fragile },
    addonTransitBase: config.addonTransitBase,
    extraDayRate: config.extraDayRate,
  };

  const { error: dbErr } = await sb
    .from("business_settings")
    .update({ pricing: stored as never })
    .eq("id", true);
  if (dbErr) return { ok: false as const, error: dbErr.message };

  revalidatePath("/settings");
  revalidatePath("/quotes");
  return { ok: true as const };
}

const num = z.coerce.number().nonnegative("Must be 0 or more");

const settingsSchema = z.object({
  estimatorFee: num,
  costFuelPerMile: num,
  costFuel75PerMile: num,
  costLabourPerDay: num,
  costBox: num,
  costVanDay: num,
  costTransitDay: num,
  cost75t: num,
  costMisc: num,
  vatDefault: z.boolean(),
  baseLocation: z.string().trim().min(1, "Base location is required").max(200),
  defaultDeposit: num,
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
      cost_fuel_75_per_mile: v.costFuel75PerMile,
      cost_labour_per_day: v.costLabourPerDay,
      cost_box: v.costBox,
      cost_van_day: v.costVanDay,
      cost_transit_day: v.costTransitDay,
      cost_75t: v.cost75t,
      cost_misc: v.costMisc,
      vat_default: v.vatDefault,
      base_location: v.baseLocation,
      default_deposit: v.defaultDeposit,
    })
    .eq("id", true);
  if (error) return { ok: false as const, error: error.message };

  revalidatePath("/settings");
  revalidatePath("/performance");
  revalidatePath("/");
  return { ok: true as const };
}
