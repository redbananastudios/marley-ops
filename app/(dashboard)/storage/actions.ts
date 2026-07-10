"use server";

import { randomBytes } from "crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import {
  allStorageAcksConfirmed,
  isValidSignatureDataUri,
  normalizeStorageAcks,
  TERMS_VERSION,
} from "@/lib/signatures";

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

/** Edit a let. Rate/notes change freely (future periods bill at the new rate);
 *  start_date/rate_period are locked once invoices exist — the billed periods
 *  are anchored to them and re-anchoring would corrupt the invoice history. */
const editLetSchema = z.object({
  rate: optNum,
  rate_period: z.enum(["week", "month"]),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z.string().trim().max(2000).optional().or(z.literal("")),
});
export type EditLetInput = z.infer<typeof editLetSchema>;

export async function editLetAction(letId: string, input: EditLetInput) {
  const parsed = editLetSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const v = parsed.data;
  const { sb, userId } = await actor();
  if (!userId) return { ok: false as const, error: "Not signed in." };

  const { data: row } = await sb.from("storage_lets").select("start_date, rate_period, end_date").eq("id", letId).single();
  if (!row) return { ok: false as const, error: "Let not found." };

  const anchorsChanged = v.start_date !== row.start_date || v.rate_period !== row.rate_period;
  if (anchorsChanged) {
    const { count } = await sb
      .from("storage_invoices")
      .select("id", { count: "exact", head: true })
      .eq("let_id", letId);
    if ((count ?? 0) > 0) {
      return {
        ok: false as const,
        error: "Invoices exist on this let — the start date and billing period are locked. Rate and notes can still change.",
      };
    }
  }
  if (row.end_date && v.start_date > row.end_date) {
    return { ok: false as const, error: "Start date can't be after the end date." };
  }

  const { error } = await sb
    .from("storage_lets")
    .update({
      rate: v.rate === "" || v.rate == null ? null : v.rate,
      rate_period: v.rate_period,
      start_date: v.start_date,
      notes: v.notes || null,
    })
    .eq("id", letId);
  if (error) return { ok: false as const, error: error.message };
  revalidatePath("/storage");
  return { ok: true as const };
}

/** Reopen an accidentally-ended let (audit gap: ending was one-way). */
export async function reopenLetAction(letId: string) {
  const { sb, userId } = await actor();
  if (!userId) return { ok: false as const, error: "Not signed in." };
  const { data: row } = await sb.from("storage_lets").select("unit_id, end_date").eq("id", letId).single();
  if (!row) return { ok: false as const, error: "Let not found." };
  if (!row.end_date) return { ok: false as const, error: "This let is already open." };

  const { error } = await sb.from("storage_lets").update({ end_date: null }).eq("id", letId);
  if (error) {
    return {
      ok: false as const,
      error: error.message.includes("storage_lets_open_uq")
        ? "The unit now has a different open let — end that one first."
        : error.message,
    };
  }
  revalidatePath("/storage");
  return { ok: true as const };
}

export async function setBillingPausedAction(letId: string, paused: boolean) {
  const { sb, userId } = await actor();
  if (!userId) return { ok: false as const, error: "Not signed in." };
  const { error } = await sb.from("storage_lets").update({ billing_paused: paused } as never).eq("id", letId);
  if (error) return { ok: false as const, error: error.message };
  revalidatePath("/storage");
  return { ok: true as const };
}

/* ------------------------------------------------------- storage agreement */

/** In-person agreement signing on the office/crew device — the default
 *  (Peter, 2026-07-10). Identical record to remote except channel. */
export async function signStorageAgreementAction(
  letId: string,
  input: { signerName: string; signatureDataUri: string; acks: Record<string, boolean> },
) {
  const { sb, userId } = await actor();
  if (!userId) return { ok: false as const, error: "Not signed in." };
  const name = input.signerName.trim();
  if (name.length < 2) return { ok: false as const, error: "Type the customer's full name." };
  if (!allStorageAcksConfirmed(input.acks)) {
    return { ok: false as const, error: "Tick each confirmation with the customer first." };
  }
  if (!isValidSignatureDataUri(input.signatureDataUri)) {
    return { ok: false as const, error: "The signature didn't come through — ask them to sign again." };
  }

  const { data: let_ } = await sb.from("storage_lets").select("id, client_id, lead_id").eq("id", letId).single();
  if (!let_) return { ok: false as const, error: "Let not found." };

  const { error } = await sb.from("signatures").insert({
    kind: "storage",
    storage_let_id: let_.id,
    client_id: let_.client_id,
    lead_id: let_.lead_id,
    signer_name: name,
    signature_data: input.signatureDataUri,
    method: "drawn",
    channel: "in_person",
    acknowledgments: normalizeStorageAcks(input.acks),
    terms_version: TERMS_VERSION,
    collected_by: userId,
  } as never);
  if (error) {
    if (error.code === "23505") return { ok: true as const }; // already signed — success state
    return { ok: false as const, error: "Could not save the signature — try again." };
  }
  revalidatePath("/storage");
  return { ok: true as const };
}

/** Remote signing link (no-one-on-site collections): mints the let's token
 *  lazily and returns the /s/<token> URL for copy/send. */
export async function getStorageSignLinkAction(letId: string) {
  const { sb, userId } = await actor();
  if (!userId) return { ok: false as const, error: "Not signed in." };
  const { data: row } = await sb.from("storage_lets").select("sign_token").eq("id", letId).single();
  if (!row) return { ok: false as const, error: "Let not found." };
  let token = row.sign_token as string | null;
  if (!token) {
    token = randomBytes(18).toString("base64url");
    const { error } = await sb.from("storage_lets").update({ sign_token: token } as never).eq("id", letId);
    if (error) return { ok: false as const, error: error.message };
  }
  return { ok: true as const, url: `https://ops.marleymoves.co.uk/s/${token}` };
}
