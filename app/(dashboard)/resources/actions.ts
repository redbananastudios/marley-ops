"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

async function actor() {
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  return { sb, userId: user?.id ?? null };
}

const optDate = z.string().trim().optional().or(z.literal(""));
// Literal "" FIRST — z.coerce.number() turns "" into 0, so an empty money field
// would silently store £0 instead of null if the union tried the number branch first.
const optMoney = z.union([z.literal(""), z.coerce.number().nonnegative("Must be 0 or more")]).optional();

/* -------------------------------------------------------------- vehicles */

const vehicleSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1, "Name is required").max(80),
  vehicle_type: z.enum(["luton", "transit", "7.5t", "other"]),
  registration: z.string().trim().max(12).optional().or(z.literal("")),
  tax_due: optDate,
  mot_due: optDate,
  insurance_renewal: optDate,
  last_service: optDate,
  service_due: optDate,
  cost_per_month: optMoney,
  payment_day: z.union([z.coerce.number().int().min(1).max(31), z.literal("")]).optional(),
  end_of_term: optDate,
  notes: z.string().trim().max(2000).optional().or(z.literal("")),
  is_active: z.boolean(),
});

export type VehicleInput = z.infer<typeof vehicleSchema>;

export async function saveVehicleAction(input: VehicleInput) {
  const parsed = vehicleSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const v = parsed.data;
  const { sb, userId } = await actor();
  if (!userId) return { ok: false as const, error: "Not signed in." };

  const row = {
    name: v.name,
    vehicle_type: v.vehicle_type,
    registration: (v.registration || "").toUpperCase(),
    tax_due: v.tax_due || null,
    mot_due: v.mot_due || null,
    insurance_renewal: v.insurance_renewal || null,
    last_service: v.last_service || null,
    service_due: v.service_due || null,
    cost_per_month: v.cost_per_month === "" || v.cost_per_month == null ? null : v.cost_per_month,
    payment_day: v.payment_day === "" || v.payment_day == null ? null : v.payment_day,
    end_of_term: v.end_of_term || null,
    notes: v.notes || null,
    is_active: v.is_active,
  };

  const { error } = v.id
    ? await sb.from("vehicles").update(row).eq("id", v.id)
    : await sb.from("vehicles").insert(row);
  if (error) return { ok: false as const, error: error.message };

  revalidatePath("/resources");
  revalidatePath("/");
  return { ok: true as const };
}

/** Archive (never hard-delete from the UI — assignments will reference vehicles). */
export async function setVehicleActiveAction(id: string, isActive: boolean) {
  const { sb, userId } = await actor();
  if (!userId) return { ok: false as const, error: "Not signed in." };
  const { error } = await sb.from("vehicles").update({ is_active: isActive }).eq("id", id);
  if (error) return { ok: false as const, error: error.message };
  revalidatePath("/resources");
  revalidatePath("/");
  return { ok: true as const };
}

/* ------------------------------------------------ vehicle off-road windows */

const unavailSchema = z
  .object({
    id: z.string().uuid().optional(),
    vehicle_id: z.string().uuid(),
    start_date: z.string().trim().min(1, "Start date is required"),
    end_date: z.string().trim().min(1, "End date is required"),
    reason: z.enum(["service", "mot", "repair", "other"]),
    note: z.string().trim().max(500).optional().or(z.literal("")),
  })
  .refine((d) => d.end_date >= d.start_date, {
    message: "End date must be on or after the start date",
    path: ["end_date"],
  });

export type VehicleUnavailabilityInput = z.infer<typeof unavailSchema>;

/** Book a van off the road (garage / repair). The Job Board drops it from that
 *  day's free capacity; the reminder engine is unaffected (dates, not windows). */
export async function saveVehicleUnavailabilityAction(input: VehicleUnavailabilityInput) {
  const parsed = unavailSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const u = parsed.data;
  const { sb, userId } = await actor();
  if (!userId) return { ok: false as const, error: "Not signed in." };

  const row = {
    vehicle_id: u.vehicle_id,
    start_date: u.start_date,
    end_date: u.end_date,
    reason: u.reason,
    note: u.note || null,
    created_by: userId,
  };
  const { error } = u.id
    ? await sb.from("vehicle_unavailability").update(row).eq("id", u.id)
    : await sb.from("vehicle_unavailability").insert(row);
  if (error) return { ok: false as const, error: error.message };

  revalidatePath("/resources");
  revalidatePath("/schedule/board");
  return { ok: true as const };
}

export async function deleteVehicleUnavailabilityAction(id: string) {
  const { sb, userId } = await actor();
  if (!userId) return { ok: false as const, error: "Not signed in." };
  const { error } = await sb.from("vehicle_unavailability").delete().eq("id", id);
  if (error) return { ok: false as const, error: error.message };
  revalidatePath("/resources");
  revalidatePath("/schedule/board");
  return { ok: true as const };
}

/* ----------------------------------------------------------------- staff */

const staffSchema = z.object({
  id: z.string().uuid().optional(),
  full_name: z.string().trim().min(1, "Name is required").max(120),
  staff_role: z.enum(["crew", "driver", "estimator", "admin"]),
  phone: z.string().trim().max(20).optional().or(z.literal("")),
  email: z.string().trim().email("Enter a valid email").optional().or(z.literal("")),
  day_rate: optMoney,
  notes: z.string().trim().max(2000).optional().or(z.literal("")),
  is_active: z.boolean(),
});

export type StaffInput = z.infer<typeof staffSchema>;

export async function saveStaffAction(input: StaffInput) {
  const parsed = staffSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const v = parsed.data;
  const { sb, userId } = await actor();
  if (!userId) return { ok: false as const, error: "Not signed in." };

  const row = {
    full_name: v.full_name,
    staff_role: v.staff_role,
    phone: v.phone || null,
    email: v.email || null,
    day_rate: v.day_rate === "" || v.day_rate == null ? null : v.day_rate,
    notes: v.notes || null,
    is_active: v.is_active,
  };

  const { error } = v.id
    ? await sb.from("staff").update(row).eq("id", v.id)
    : await sb.from("staff").insert(row);
  if (error) return { ok: false as const, error: error.message };

  revalidatePath("/resources");
  return { ok: true as const };
}

export async function setStaffActiveAction(id: string, isActive: boolean) {
  const { sb, userId } = await actor();
  if (!userId) return { ok: false as const, error: "Not signed in." };
  const { error } = await sb.from("staff").update({ is_active: isActive }).eq("id", id);
  if (error) return { ok: false as const, error: error.message };
  revalidatePath("/resources");
  return { ok: true as const };
}
