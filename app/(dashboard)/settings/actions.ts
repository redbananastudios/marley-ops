"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { VEHICLE_KEYS } from "@/lib/quote/constants";
import { toPricingConfig, type EditablePricing } from "@/lib/quote/pricing-config";
import { sendEmail } from "@/lib/comms/send";
import { fleetDigestHtml, fleetDigestSubject, type DigestItem } from "@/lib/fleet/reminder-email";
import { sendPushForEvent } from "@/lib/push/send";
import { fleetExpiryDigestPush } from "@/lib/push/categories";
import { storageRatesToDb } from "@/lib/storage-rates";

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
  estimatorPhoneQuoteFee: num,
  estimatorCommissionPct: z.coerce.number().min(0, "Commission % must be 0–100").max(100, "Commission % must be 0–100"),
  costFuelPerMile: num,
  costFuel75PerMile: num,
  costLabourPerDay: num,
  costBox: num,
  costVanDay: num,
  costTransitDay: num,
  cost75t: num,
  costMisc: num,
  vatDefault: z.boolean(),
  vatNumber: z.string().trim().max(20),
  vatStaggerGroup: z.coerce.number().int().min(1).max(3),
  vatScheme: z.enum(["standard", "flat_rate"]),
  vatFlatRatePct: z.coerce.number().min(1, "FRS % must be 1–16.5").max(16.5, "FRS % must be 1–16.5"),
  baseLocation: z.string().trim().min(1, "Base location is required").max(200),
  defaultDeposit: num,
  googleReviewUrl: z
    .string()
    .trim()
    .max(500)
    .refine((s) => !s || /^https:\/\//.test(s), "Must be an https:// link (or empty to disable)"),
  cubicFillPct: z.coerce.number().min(50, "Fill % must be 50–100").max(100, "Fill % must be 50–100"),
  cubicTransitFt3: z.coerce.number().positive("Must be above 0").max(5000),
  cubicLutonFt3: z.coerce.number().positive("Must be above 0").max(5000),
  cubic75tFt3: z.coerce.number().positive("Must be above 0").max(10000),
});

export type SettingsInput = z.infer<typeof settingsSchema>;

/* --------------------------------------------------- fleet reminders (admin) */

const fleetSchema = z.object({
  enabled: z.boolean(),
  pushEnabled: z.boolean(),
  recipients: z.array(z.string().trim().email("One of the addresses is not a valid email")).max(20),
});
export type FleetRemindersInput = z.infer<typeof fleetSchema>;

/** Save the fleet-reminder recipients + kill switches (admin only). */
export async function saveFleetRemindersAction(input: FleetRemindersInput) {
  const parsed = fleetSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { sb, error } = await requireAdmin();
  if (error) return { ok: false as const, error };
  const v = parsed.data;
  // Dedupe + lowercase so the list stays clean.
  const recipients = Array.from(new Set(v.recipients.map((e) => e.toLowerCase())));
  const { error: dbErr } = await sb
    .from("business_settings")
    .update({
      fleet_reminders_enabled: v.enabled,
      push_fleet_expiry_enabled: v.pushEnabled,
      fleet_alert_recipients: recipients as never,
    })
    .eq("id", true);
  if (dbErr) return { ok: false as const, error: dbErr.message };
  revalidatePath("/settings");
  return { ok: true as const, recipients };
}

/* --------------------------------------------------------- storage rates (admin) */

const storageMoney = z.coerce.number().nonnegative("Must be 0 or more");
const storageRatesSchema = z.object({
  containerMonthInc: storageMoney,
  crateWeekInc: storageMoney,
  crateDayInc: storageMoney,
  crateMinDays: z.coerce.number().int("Minimum days must be a whole number").positive("Minimum days must be at least 1"),
  crateMinInc: storageMoney,
  handlingEventInc: storageMoney,
  supplier: z.object({
    containerMonthCost: storageMoney,
    containersCount: z.coerce.number().int("Containers held must be a whole number").nonnegative("Must be 0 or more"),
    crateDayCost: storageMoney,
    handlingEventCost: storageMoney,
  }),
});
export type StorageRatesInput = z.infer<typeof storageRatesSchema>;

/** Save the storage rate card (admin only). New lets COPY these figures at
 *  creation — running lets keep their frozen rate, so this never disturbs live
 *  billing (docs/storage-billing-v2-prd.md §1). */
export async function saveStorageRatesAction(input: StorageRatesInput) {
  const parsed = storageRatesSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues[0]?.message ?? "Invalid rates" };
  }
  const { sb, error } = await requireAdmin();
  if (error) return { ok: false as const, error };
  const { error: dbErr } = await sb
    .from("business_settings")
    // Record<string, unknown> → the generated Json column type (plain data).
    .update({ storage_rates: storageRatesToDb(parsed.data) as never })
    .eq("id", true);
  if (dbErr) return { ok: false as const, error: dbErr.message };
  revalidatePath("/settings");
  revalidatePath("/storage");
  return { ok: true as const };
}

/** The sink the test alert always uses — never a real customer or an unverified
 *  teammate address during setup. */
/** Master switch for crew self-billing (admin only). Off by default — the signed
 *  self-billing agreement is the go-live gate; while off, the crew /my-jobs "My
 *  pay" surface stays hidden and all pay actions reject. */
export async function setSelfBillingEnabledAction(enabled: boolean) {
  const { sb, error } = await requireAdmin();
  if (error) return { ok: false as const, error };
  const { error: dbErr } = await sb
    .from("business_settings")
    .update({ self_billing_enabled: !!enabled })
    .eq("id", true);
  if (dbErr) return { ok: false as const, error: dbErr.message };
  revalidatePath("/settings");
  revalidatePath("/finance/statements");
  revalidatePath("/my-jobs");
  return { ok: true as const };
}

const FLEET_TEST_SINK = "peter@abacusonline.net";

/** Send a sample fleet reminder (email to the test sink + a self-push) so the
 *  admin can prove the pipeline before real dates come due. Admin only. */
export async function sendFleetTestAction() {
  const { sb, error } = await requireAdmin();
  if (error) return { ok: false as const, error };
  const {
    data: { user },
  } = await sb.auth.getUser();

  const in7 = new Date();
  in7.setDate(in7.getDate() + 7);
  const sample: DigestItem[] = [
    { vehicleName: "Luton 1 (sample)", expiryLabel: "MOT", dueDate: in7.toISOString().slice(0, 10), days: 7 },
  ];
  const res = await sendEmail({
    to: FLEET_TEST_SINK,
    subject: `[TEST] ${fleetDigestSubject(sample)}`,
    html: fleetDigestHtml(sample),
    replyTo: "hello@marleymoves.co.uk",
  });
  // Best-effort self-push (respects the global switch, bypasses the category one).
  if (user?.id) {
    await sendPushForEvent(fleetExpiryDigestPush(1), { admin: createAdminClient(), onlyUserId: user.id, isTest: true });
  }
  if (!res.ok) return { ok: false as const, error: res.error ?? "Email send failed" };
  return { ok: true as const, sink: FLEET_TEST_SINK };
}

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
      estimator_phone_quote_fee: v.estimatorPhoneQuoteFee,
      estimator_commission_pct: v.estimatorCommissionPct,
      cost_fuel_per_mile: v.costFuelPerMile,
      cost_fuel_75_per_mile: v.costFuel75PerMile,
      cost_labour_per_day: v.costLabourPerDay,
      cost_box: v.costBox,
      cost_van_day: v.costVanDay,
      cost_transit_day: v.costTransitDay,
      cost_75t: v.cost75t,
      cost_misc: v.costMisc,
      vat_default: v.vatDefault,
      vat_number: (v.vatNumber || null) as never,
      vat_stagger_group: v.vatStaggerGroup as never,
      vat_scheme: v.vatScheme as never,
      vat_flat_rate_pct: v.vatFlatRatePct as never,
      base_location: v.baseLocation,
      default_deposit: v.defaultDeposit,
      google_review_url: v.googleReviewUrl,
      cubic_fill_pct: v.cubicFillPct,
      cubic_transit_ft3: v.cubicTransitFt3,
      cubic_luton_ft3: v.cubicLutonFt3,
      cubic_75t_ft3: v.cubic75tFt3,
    })
    .eq("id", true);
  if (error) return { ok: false as const, error: error.message };

  revalidatePath("/settings");
  revalidatePath("/performance");
  revalidatePath("/finance");
  revalidatePath("/");
  return { ok: true as const };
}
