"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { normalizeWorkingDays } from "@/lib/staff/availability";

async function actor() {
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  return { sb, userId: user?.id ?? null };
}

/** Staff & Fleet writes are an OFFICE surface. This gates them at the app layer
 *  in addition to RLS — a crew login could otherwise call saveStaffAction to edit
 *  their own staff row (their staff_update RLS permits it). Pay is now separate:
 *  staff_pay is office-write-only at the RLS layer, so rates can't be self-set
 *  even via the raw API. */
async function requireOfficeActor() {
  const profile = await getSessionProfile();
  if (!profile) return { error: "Not signed in." as const };
  if (profile.role !== "admin" && profile.role !== "estimator") return { error: "Office only." as const };
  const sb = await createClient();
  return { sb, userId: profile.id, role: profile.role };
}

function nextDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
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
    // Real YYYY-MM-DD (the <input type="date"> always is) — reject a crafted
    // API call cleanly instead of letting a bad string reach the date column.
    start_date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid start date"),
    end_date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid end date"),
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
  // Pay: hourly rate + optional weekly guarantee (Rob: £600/wk floor). Stored in
  // the office-scoped staff_pay table, not on the crew-readable staff row.
  hourly_rate: optMoney,
  weekly_guarantee: optMoney,
  // The crew member's normal weekly pattern (ISO weekday numbers 1=Mon…7=Sun).
  // Undefined = leave unchanged (a caller that doesn't manage the pattern).
  working_days: z.array(z.number().int().min(1).max(7)).max(7).optional(),
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
  const ctx = await requireOfficeActor();
  if ("error" in ctx) return { ok: false as const, error: ctx.error };
  const { sb, role } = ctx;

  const row = {
    full_name: v.full_name,
    staff_role: v.staff_role,
    phone: v.phone || null,
    email: v.email || null,
    notes: v.notes || null,
    is_active: v.is_active,
    // Only touch the pattern when the caller manages it — an insert without it
    // falls back to the '{1,2,3,4,5}' column default (Mon–Fri).
    ...(v.working_days !== undefined ? { working_days: normalizeWorkingDays(v.working_days) } : {}),
  };

  let staffId = v.id ?? null;
  if (v.id) {
    const { error } = await sb.from("staff").update(row).eq("id", v.id);
    if (error) return { ok: false as const, error: error.message };
  } else {
    const { data: created, error } = await sb.from("staff").insert(row).select("id").single();
    if (error || !created) return { ok: false as const, error: error?.message ?? "Could not save the crew member." };
    staffId = created.id;
  }

  // Pay lives in the admin-scoped staff_pay table (crew can't read a colleague's
  // rate; estimators can't see rates at all). Only an ADMIN writes rates — an
  // estimator saving a staff record leaves pay untouched (and never sends it).
  if (staffId && role === "admin") {
    const hourly = v.hourly_rate === "" || v.hourly_rate == null ? null : v.hourly_rate;
    const guarantee = v.weekly_guarantee === "" || v.weekly_guarantee == null ? null : v.weekly_guarantee;
    const { error: payErr } = await sb
      .from("staff_pay")
      .upsert({ staff_id: staffId, hourly_rate: hourly, weekly_guarantee: guarantee }, { onConflict: "staff_id" });
    if (payErr) {
      // New staff + pay write failed → delete the orphan staff row so a retry
      // doesn't create a duplicate crew member (the two writes aren't one txn).
      if (!v.id) await sb.from("staff").delete().eq("id", staffId);
      return { ok: false as const, error: payErr.message };
    }
  }

  revalidatePath("/resources");
  revalidatePath("/schedule/board");
  return { ok: true as const };
}

export async function setStaffActiveAction(id: string, isActive: boolean) {
  const ctx = await requireOfficeActor();
  if ("error" in ctx) return { ok: false as const, error: ctx.error };
  const { sb } = ctx;
  const { error } = await sb.from("staff").update({ is_active: isActive }).eq("id", id);
  if (error) return { ok: false as const, error: error.message };
  revalidatePath("/resources");
  return { ok: true as const };
}

/* ----------------------------------------------- staff availability (office) */

const staffAvailSchema = z
  .object({
    staff_id: z.string().uuid(),
    start_date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid start date"),
    end_date: z
      .union([z.literal(""), z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid end date")])
      .optional(),
    status: z.enum(["available", "unavailable"]),
    note: z.string().trim().max(500).optional().or(z.literal("")),
  })
  .refine((d) => !d.end_date || d.end_date >= d.start_date, {
    message: "End date must be on or after the start date",
    path: ["end_date"],
  });

export type StaffAvailabilityInput = z.infer<typeof staffAvailSchema>;

const MAX_AVAIL_DAYS = 92;

/** Office sets a staff member's availability across a single date or a range
 *  (one row per UK day). 'unavailable' books a day off / holiday, 'available'
 *  offers a weekend. RLS lets office write anyone's; a crew member only their
 *  own — so the same table serves both the crew portal and this editor. */
export async function saveStaffAvailabilityAction(input: StaffAvailabilityInput) {
  const parsed = staffAvailSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const a = parsed.data;
  const ctx = await requireOfficeActor();
  if ("error" in ctx) return { ok: false as const, error: ctx.error };
  const { sb, userId } = ctx;

  // Forward-only: the Resources view lists availability from today on, so a
  // past-dated row would be an orphan it can never delete. Drop past days;
  // reject a range that is entirely in the past.
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
  const end = a.end_date || a.start_date;
  const dates: string[] = [];
  let iterations = 0;
  for (let d = a.start_date; d <= end; d = nextDay(d)) {
    if (++iterations > MAX_AVAIL_DAYS) return { ok: false as const, error: "Pick a range of 3 months or less." };
    if (d >= today) dates.push(d);
  }
  if (!dates.length) return { ok: false as const, error: "Those dates are in the past." };
  const rows = dates.map((date) => ({
    staff_id: a.staff_id,
    date,
    status: a.status,
    note: a.note || null,
    created_by: userId,
  }));
  const { error } = await sb.from("staff_availability").upsert(rows, { onConflict: "staff_id,date" });
  if (error) return { ok: false as const, error: error.message };

  revalidatePath("/resources");
  revalidatePath("/schedule/board");
  return { ok: true as const };
}

/** Remove one or more availability rows — a whole grouped run at once. */
export async function deleteStaffAvailabilityAction(ids: string[]) {
  const clean = [...new Set(ids)].filter((id) => typeof id === "string" && id.length > 0);
  if (!clean.length) return { ok: false as const, error: "Nothing to remove." };
  const ctx = await requireOfficeActor();
  if ("error" in ctx) return { ok: false as const, error: ctx.error };
  const { sb } = ctx;
  const { error } = await sb.from("staff_availability").delete().in("id", clean);
  if (error) return { ok: false as const, error: error.message };
  revalidatePath("/resources");
  revalidatePath("/schedule/board");
  return { ok: true as const };
}

const cellSchema = z.object({
  staff_id: z.string().uuid(),
  date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date"),
  status: z.enum(["available", "unavailable", "clear"]),
  note: z.string().trim().max(500).optional().or(z.literal("")),
});

export type SetStaffAvailabilityCellInput = z.infer<typeof cellSchema>;

/** Office amends ONE crew member's availability for ONE day from the wall chart:
 *  upsert an override or clear it back to the pattern default. Forward-only to
 *  match the forward-only view (a past day off is history). RLS: is_office(). */
export async function setStaffAvailabilityCellAction(input: SetStaffAvailabilityCellInput) {
  const parsed = cellSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const a = parsed.data;
  const ctx = await requireOfficeActor();
  if ("error" in ctx) return { ok: false as const, error: ctx.error };
  const { sb, userId } = ctx;

  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
  if (a.date < today) return { ok: false as const, error: "That day has already passed." };

  if (a.status === "clear") {
    const { error } = await sb.from("staff_availability").delete().eq("staff_id", a.staff_id).eq("date", a.date);
    if (error) return { ok: false as const, error: error.message };
  } else {
    const { error } = await sb
      .from("staff_availability")
      .upsert(
        { staff_id: a.staff_id, date: a.date, status: a.status, note: a.note || null, created_by: userId },
        { onConflict: "staff_id,date" },
      );
    if (error) return { ok: false as const, error: error.message };
  }

  revalidatePath("/resources");
  revalidatePath("/schedule/board");
  return { ok: true as const };
}
