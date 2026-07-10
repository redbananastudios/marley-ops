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

// Literal "" FIRST — z.coerce.number() turns "" into 0, so an empty money/size
// field would silently store 0 instead of null if the number branch ran first.
const optNum = z.union([z.literal(""), z.coerce.number().nonnegative("Must be 0 or more")]).optional();

/* ------------------------------------------------------------------- sites */

const siteSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1, "Name is required").max(120),
  address: z.string().trim().max(300).optional().or(z.literal("")),
  notes: z.string().trim().max(2000).optional().or(z.literal("")),
  is_active: z.boolean(),
});

export type SiteInput = z.infer<typeof siteSchema>;

export async function saveSiteAction(input: SiteInput) {
  const parsed = siteSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const v = parsed.data;
  const { sb, userId } = await actor();
  if (!userId) return { ok: false as const, error: "Not signed in." };

  const row = { name: v.name, address: v.address || "", notes: v.notes || null, is_active: v.is_active };
  const { error } = v.id
    ? await sb.from("storage_sites").update(row).eq("id", v.id)
    : await sb.from("storage_sites").insert(row);
  if (error) return { ok: false as const, error: error.message };

  revalidatePath("/storage");
  return { ok: true as const };
}

export async function setSiteActiveAction(id: string, isActive: boolean) {
  const { sb, userId } = await actor();
  if (!userId) return { ok: false as const, error: "Not signed in." };
  if (!isActive) {
    // Don't archive a site while any of its units holds an open let.
    const { data: units } = await sb.from("storage_units").select("id").eq("site_id", id);
    const ids = (units ?? []).map((u) => u.id);
    if (ids.length) {
      const { count } = await sb
        .from("storage_lets")
        .select("id", { count: "exact", head: true })
        .in("unit_id", ids)
        .is("end_date", null);
      if ((count ?? 0) > 0)
        return { ok: false as const, error: "This site still has occupied units — end those lets first." };
    }
  }
  const { error } = await sb.from("storage_sites").update({ is_active: isActive }).eq("id", id);
  if (error) return { ok: false as const, error: error.message };
  revalidatePath("/storage");
  return { ok: true as const };
}

/* ------------------------------------------------------------------- units */

const unitSchema = z.object({
  id: z.string().uuid().optional(),
  site_id: z.string().uuid(),
  code: z.string().trim().max(40).optional().or(z.literal("")),
  name: z.string().trim().max(120).optional().or(z.literal("")),
  unit_type: z.enum(["crate_250", "container_20ft", "container_40ft", "room", "other"]),
  size_cuft: optNum,
  notes: z.string().trim().max(2000).optional().or(z.literal("")),
  is_active: z.boolean(),
});

export type UnitInput = z.infer<typeof unitSchema>;

export async function saveUnitAction(input: UnitInput) {
  const parsed = unitSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const v = parsed.data;
  if (!(v.code || "").trim() && !(v.name || "").trim())
    return { ok: false as const, error: "Give the unit a code or a name." };
  const { sb, userId } = await actor();
  if (!userId) return { ok: false as const, error: "Not signed in." };

  const row = {
    site_id: v.site_id,
    code: (v.code || "").toUpperCase(),
    name: v.name || "",
    unit_type: v.unit_type,
    size_cuft: v.size_cuft === "" || v.size_cuft == null ? null : v.size_cuft,
    notes: v.notes || null,
    is_active: v.is_active,
  };
  const { error } = v.id
    ? await sb.from("storage_units").update(row).eq("id", v.id)
    : await sb.from("storage_units").insert(row);
  if (error) return { ok: false as const, error: error.message };

  revalidatePath("/storage");
  return { ok: true as const };
}

export async function setUnitActiveAction(id: string, isActive: boolean) {
  const { sb, userId } = await actor();
  if (!userId) return { ok: false as const, error: "Not signed in." };
  if (!isActive) {
    const { count } = await sb
      .from("storage_lets")
      .select("id", { count: "exact", head: true })
      .eq("unit_id", id)
      .is("end_date", null);
    if ((count ?? 0) > 0) return { ok: false as const, error: "This unit is occupied — end the let first." };
  }
  const { error } = await sb.from("storage_units").update({ is_active: isActive }).eq("id", id);
  if (error) return { ok: false as const, error: error.message };
  revalidatePath("/storage");
  return { ok: true as const };
}

/* -------------------------------------------------------------------- lets */

const startLetSchema = z.object({
  unit_id: z.string().uuid(),
  client_id: z.string().uuid("Pick a client"),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a start date"),
  rate: optNum,
  rate_period: z.enum(["week", "month"]),
  notes: z.string().trim().max(2000).optional().or(z.literal("")),
});

export type StartLetInput = z.infer<typeof startLetSchema>;

export async function startLetAction(input: StartLetInput) {
  const parsed = startLetSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const v = parsed.data;
  const { sb, userId } = await actor();
  if (!userId) return { ok: false as const, error: "Not signed in." };

  // App-level guard; the partial unique index (one open let per unit) is the backstop.
  const { count } = await sb
    .from("storage_lets")
    .select("id", { count: "exact", head: true })
    .eq("unit_id", v.unit_id)
    .is("end_date", null);
  if ((count ?? 0) > 0) return { ok: false as const, error: "This unit is already occupied." };

  const { error } = await sb.from("storage_lets").insert({
    unit_id: v.unit_id,
    client_id: v.client_id,
    start_date: v.start_date,
    rate: v.rate === "" || v.rate == null ? null : v.rate,
    rate_period: v.rate_period,
    notes: v.notes || null,
  });
  if (error) {
    return {
      ok: false as const,
      error: error.message.includes("storage_lets_open_uq") ? "This unit is already occupied." : error.message,
    };
  }

  revalidatePath("/storage");
  return { ok: true as const };
}

export async function endLetAction(letId: string, endDate: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return { ok: false as const, error: "Pick an end date." };
  const { sb, userId } = await actor();
  if (!userId) return { ok: false as const, error: "Not signed in." };

  const { data: row } = await sb.from("storage_lets").select("start_date, end_date").eq("id", letId).single();
  if (!row) return { ok: false as const, error: "Let not found." };
  if (row.end_date) return { ok: false as const, error: "This let is already ended." };
  if (endDate < row.start_date) return { ok: false as const, error: "End date can't be before the start date." };

  const { error } = await sb.from("storage_lets").update({ end_date: endDate }).eq("id", letId);
  if (error) return { ok: false as const, error: error.message };

  revalidatePath("/storage");
  return { ok: true as const };
}
