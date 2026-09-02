"use server";

import { randomBytes } from "crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOfficeProfile } from "@/lib/ai/auth";
import { dispatchComm, type DispatchCommResult } from "@/lib/comms/dispatch";
import { brandedEmailHtml } from "@/lib/comms/branded-shell";
import {
  allCrateStorageAcksConfirmed,
  allStorageAcksConfirmed,
  crateStorageAcks,
  isValidSignatureDataUri,
  normalizeCrateStorageAcks,
  normalizeStorageAcks,
  storageAcks,
} from "@/lib/signatures";
import { termsSnapshot } from "@/lib/legal/documents";
import { DEFAULT_BRAND, getBrandOrDefault, listActiveBrandsForWrite } from "@/lib/brand";
import { pageTheme } from "@/lib/brand-page-theme";
import { helloFromFor } from "@/lib/comms/sender";
import { getStorageRates, gbpInc } from "@/lib/storage-rates";
import { raiseDueStorageInvoices, repairPendingStorageClaims } from "@/lib/storage/raise-storage-invoices";

const UK_TODAY = (): string => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });

const FROM = "Marley Moves <hello@marleymoves.co.uk>";

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
  brand: z.string().trim().optional().or(z.literal("")),
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

  const row: { name: string; address: string; notes: string | null; is_active: boolean; brand?: string } = {
    name: v.name,
    address: v.address || "",
    notes: v.notes || null,
    is_active: v.is_active,
  };
  // GATE 12 — the site's brand, validated SERVER-SIDE against active brands
  // (data, not a constant list — multi-brand PRD §4 /storage). Single-brand
  // mode: the dialog's selector never rendered, so whatever arrived is
  // ignored and the column stays untouched — inserts take the DB default
  // (DEFAULT_BRAND), edits keep their stored value: today's behaviour.
  // Multi-brand: a provided slug must be active; absent defaults new sites
  // to DEFAULT_BRAND and leaves an edited site's brand alone. A failed brands
  // read refuses — swallowed to [], an office-picked brand would be silently
  // discarded and the insert would take the DB default.
  const brandsRes = await listActiveBrandsForWrite(sb);
  if (!brandsRes.ok) return { ok: false as const, error: brandsRes.error };
  const activeBrands = brandsRes.brands;
  if (activeBrands.length > 1) {
    if (v.brand) {
      if (!activeBrands.some((b) => b.slug === v.brand)) {
        return { ok: false as const, error: "Choose which brand this site belongs to." };
      }
      row.brand = v.brand;
    } else if (!v.id) {
      row.brand = DEFAULT_BRAND;
    }
  }
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
  rate_period: z.enum(["week", "month", "day"]),
  billing_model: z.enum(["period", "crate_daily"]).default("period"),
  min_days: optNum,
  min_amount: optNum,
  /** Crate lets: record the "handling in" event at commencement (default on). */
  record_handling_in: z.boolean().optional(),
  handling_amount: optNum,
  /** Multi-brand override only — "" / absent means resolve server-side. */
  brand: z.string().trim().optional().or(z.literal("")),
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

  const asNum = (x: number | "" | undefined): number | null => (x === "" || x == null ? null : x);
  const minDays = asNum(v.min_days);
  const minAmount = asNum(v.min_amount);
  if (v.billing_model === "crate_daily") {
    if (v.rate_period !== "day") return { ok: false as const, error: "Crate storage bills a day rate." };
    // An unpriced crate would bill £0/day forever — the engine has no
    // "as agreed" fallback for the daily-arrears model.
    const dayRate = asNum(v.rate);
    if (!dayRate || dayRate <= 0) return { ok: false as const, error: "Set the day rate — crate storage bills per day." };
    if (!minDays || minDays < 1) return { ok: false as const, error: "Set the minimum-stay days." };
    if (minAmount == null || minAmount < 0) return { ok: false as const, error: "Set the minimum-stay charge." };
    // Ticked handling-in with no amount must fail loudly, not silently skip
    // the event (the charge would quietly never bill).
    if (v.record_handling_in) {
      const handling = asNum(v.handling_amount);
      if (!handling || handling <= 0) {
        return { ok: false as const, error: "Enter the handling charge (or untick record handling in)." };
      }
    }
  } else if (v.rate_period === "day") {
    return { ok: false as const, error: "Day rates are for crate storage — pick weekly or monthly." };
  }

  // The billing model must match the physical product — crates bill per day
  // in arrears, everything else per period in advance. A mismatch here would
  // mis-route the billing engine for the life of the let.
  const { data: unit } = await sb.from("storage_units").select("unit_type, site_id").eq("id", v.unit_id).single();
  if (!unit) return { ok: false as const, error: "Unit not found." };
  if (v.billing_model === "crate_daily" && unit.unit_type !== "crate_250") {
    return { ok: false as const, error: "Day-rate crate billing is only for crate units — this unit bills per period." };
  }
  if (unit.unit_type === "crate_250" && v.billing_model !== "crate_daily") {
    return { ok: false as const, error: "Crates bill per day in arrears — start this let on the crate billing model." };
  }

  // App-level guard; the partial unique index (one open let per unit) is the backstop.
  const { count } = await sb
    .from("storage_lets")
    .select("id", { count: "exact", head: true })
    .eq("unit_id", v.unit_id)
    .is("end_date", null);
  if ((count ?? 0) > 0) return { ok: false as const, error: "This unit is already occupied." };

  // GATE 12 — the let's brand (multi-brand PRD §2 + §3.2): the client's most
  // recent lead's brand, falling back to the site's. Resolved SERVER-SIDE at
  // write time; the dialog's pre-filled selector only posts a value when the
  // office overrides it. Single-brand mode: nothing is sent, nothing is
  // stamped and the insert is unchanged — the DB default writes DEFAULT_BRAND
  // silently, today's behaviour. Attribution only this gate (PRD §11.10):
  // rates, billing model and invoicing carry no brand.
  let letBrand: string | null = null;
  // A failed brands read refuses (never reads as single-brand mode) — the
  // let's attribution stamp lives for the whole let.
  const brandsRes = await listActiveBrandsForWrite(sb);
  if (!brandsRes.ok) return { ok: false as const, error: brandsRes.error };
  const activeBrands = brandsRes.brands;
  if (activeBrands.length > 1) {
    if (v.brand) {
      if (!activeBrands.some((b) => b.slug === v.brand)) {
        return { ok: false as const, error: "Choose which brand this let belongs to." };
      }
      letBrand = v.brand;
    } else {
      // Resolution reads fail LOUD — a fail-soft fallback here would silently
      // mis-brand the let's attribution for its whole life.
      const { data: lastLead, error: leadErr } = await sb
        .from("leads")
        .select("brand")
        .eq("client_id", v.client_id)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (leadErr) {
        return { ok: false as const, error: `Could not resolve the client's brand: ${leadErr.message}` };
      }
      if (lastLead?.brand) {
        letBrand = lastLead.brand;
      } else {
        const { data: site, error: siteErr } = await sb
          .from("storage_sites")
          .select("brand")
          .eq("id", unit.site_id)
          .single();
        if (siteErr || !site) {
          return { ok: false as const, error: "Could not resolve the site's brand — try again." };
        }
        letBrand = site.brand;
      }
    }
  }

  const { data: created, error } = await sb
    .from("storage_lets")
    .insert({
      unit_id: v.unit_id,
      client_id: v.client_id,
      start_date: v.start_date,
      rate: asNum(v.rate),
      rate_period: v.rate_period,
      billing_model: v.billing_model,
      min_days: v.billing_model === "crate_daily" ? minDays : null,
      min_amount: v.billing_model === "crate_daily" ? minAmount : null,
      // NEW crate lets sign storage-terms v2 (2026-08-31): the minimum is one
      // CALENDAR month, frozen here so the let keeps that rule for life.
      // min_days stays recorded as the legacy fallback but the engine ignores
      // it for calendar_month lets (lib/storage-billing.ts crateMinimumEnd).
      min_kind: v.billing_model === "crate_daily" ? "calendar_month" : "days",
      notes: v.notes || null,
      ...(letBrand ? { brand: letBrand } : {}),
    } as never)
    .select("id")
    .single();
  if (error || !created) {
    return {
      ok: false as const,
      error: error?.message.includes("storage_lets_open_uq") ? "This unit is already occupied." : (error?.message ?? "Could not start the let."),
    };
  }

  // Ingress handling event — the "in" half of "per crate in and out". Rides
  // the minimum invoice when the billing cron (or release flow) raises it.
  let warning: string | undefined;
  const handlingAmount = asNum(v.handling_amount);
  if (v.billing_model === "crate_daily" && v.record_handling_in && handlingAmount != null && handlingAmount > 0) {
    const { error: evErr } = await sb.from("storage_handling_events").insert({
      let_id: created.id,
      client_id: v.client_id,
      event_date: v.start_date,
      kind: "in",
      amount: handlingAmount,
      created_by: userId,
    } as never);
    if (evErr) warning = "Let started, but the handling-in event failed to save — add it from Manage.";
  }

  revalidatePath("/storage");
  return { ok: true as const, warning };
}

export interface EndLetOptions {
  /** Crate lets: record the egress handling event dated endDate (default on in the UI). */
  recordHandlingOut?: boolean;
  handlingAmount?: number;
  /** Raise the settlement invoice(s) immediately — "all charges settled before
   *  release". Defaults on; a failure falls back to the daily cron retry. */
  billNow?: boolean;
}

// The dialog omits handlingAmount when the charge is unticked (older callers
// sent 0), so the schema tolerates absent/0; strict positivity is enforced
// below only when recordHandlingOut is actually on.
const endLetInputSchema = z.object({
  letId: z.string().uuid("Let not found."),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick an end date."),
  opts: z
    .object({
      recordHandlingOut: z.boolean().optional(),
      handlingAmount: z.coerce
        .number()
        .nonnegative("Enter the handling charge")
        .max(100_000, "Handling charge is too large.")
        .optional(),
      billNow: z.boolean().optional(),
    })
    .optional(),
});

/** "10 Aug" — office-facing note dates (year omitted; the note is immediate). */
const shortDay = (iso: string): string =>
  new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });

export async function endLetAction(letId: string, endDate: string, opts?: EndLetOptions) {
  const parsed = endLetInputSchema.safeParse({ letId, endDate, opts });
  if (!parsed.success) return { ok: false as const, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const v = parsed.data;
  const handlingAmount = v.opts?.handlingAmount ?? 0;
  if (v.opts?.recordHandlingOut && handlingAmount <= 0) {
    return { ok: false as const, error: "Enter the handling charge (or untick charge handling out)." };
  }
  const { sb, userId } = await actor();
  if (!userId) return { ok: false as const, error: "Not signed in." };
  // The inline settlement runs on the admin client (Zoho + claim writes), so
  // gate explicitly — RLS on storage_lets covers the update but not that path.
  const office = await requireOfficeProfile();
  if (!office) return { ok: false as const, error: "Office access required." };

  const { data: row } = await sb
    .from("storage_lets")
    .select("start_date, end_date, client_id, billing_model")
    .eq("id", v.letId)
    .single();
  if (!row) return { ok: false as const, error: "Let not found." };
  if (row.end_date) return { ok: false as const, error: "This let is already ended." };
  if (v.endDate < row.start_date) return { ok: false as const, error: "End date can't be before the start date." };

  // Backdated-release check — CRATE day-exact charges only. A crate arrears or
  // final invoice whose window passes the chosen end date billed days the
  // goods weren't stored, which the agreement doesn't cover. The crate MINIMUM
  // and every period-let invoice bill in full by policy (no pro-rata on
  // release), so an end date inside those windows is normal, not an overbill.
  // The end still proceeds — the goods left, and blocking would force a wrong
  // date — but the office is told to square the books.
  let overbilledNote: string | undefined;
  if ((row as { billing_model?: string }).billing_model === "crate_daily") {
    const { data: invRows, error: invErr } = await sb
      .from("storage_invoices")
      .select("period_end")
      .eq("let_id", v.letId)
      .neq("status", "void")
      .in("kind", ["arrears", "final"])
      .order("period_end", { ascending: false })
      .limit(1);
    if (invErr) return { ok: false as const, error: invErr.message };
    const maxPeriodEnd = invRows?.[0]?.period_end?.slice(0, 10);
    if (maxPeriodEnd && v.endDate < maxPeriodEnd) {
      overbilledNote = `Days after ${shortDay(v.endDate)} were already invoiced (cycle to ${shortDay(maxPeriodEnd)}) — raise a credit note in Zoho for the difference.`;
    }
  }

  const { error } = await sb.from("storage_lets").update({ end_date: v.endDate }).eq("id", v.letId);
  if (error) return { ok: false as const, error: error.message };

  // Egress event AFTER the end date lands — an event without the release would
  // ride a future cycle invoice as a stray charge. If this insert fails the let
  // is still ended; ended lets no longer take panel events, so the charge is
  // added in Zoho by hand.
  let eventError: string | undefined;
  if (
    (row as { billing_model?: string }).billing_model === "crate_daily" &&
    v.opts?.recordHandlingOut &&
    handlingAmount > 0
  ) {
    const { error: evErr } = await sb.from("storage_handling_events").insert({
      let_id: v.letId,
      client_id: row.client_id,
      event_date: v.endDate,
      kind: "out",
      amount: handlingAmount,
      created_by: userId,
    } as never);
    if (evErr) eventError = `handling-out event failed (${evErr.message}) — add the charge in Zoho manually`;
  }

  // Release settlement: raise the final invoice(s) now rather than waiting for
  // the 08:00 cron — the policy is "settled before goods leave". Fail-soft:
  // the claim machinery releases on failure and the cron retries tomorrow.
  // settlementChecked is true ONLY when the run completed with no fatal and no
  // thrown exception — the UI must never report an unverified settlement.
  let raised: { invoiceNumber: string; amount: number; kind: string }[] = [];
  let billingError: string | undefined = eventError;
  let settlementChecked = false;
  if (v.opts?.billNow !== false) {
    const adminSb = createAdminClient();
    // Complete any claim stranded 'pending' by an earlier crash FIRST. The
    // raise core already refuses to re-sweep a claimed event, so money stays
    // right either way — but adopting here links the invoice and surfaces its
    // alerts before the goods leave rather than at tomorrow's cron.
    try {
      const rep = await repairPendingStorageClaims(adminSb, { todayIso: UK_TODAY(), letId: v.letId });
      if (rep.alerts.length) billingError = [billingError, ...rep.alerts].filter(Boolean).join("; ");
    } catch {
      // best-effort — claimed-event exclusion in the raise keeps money safe
    }
    try {
      const summary = await raiseDueStorageInvoices(adminSb, { todayIso: UK_TODAY(), letId: v.letId });
      raised = summary.invoices.map(({ invoiceNumber, amount, kind }) => ({ invoiceNumber, amount, kind }));
      if (summary.fatal) {
        // A ledger read failed and nothing was raised — the cron retries.
        billingError = [eventError, summary.fatal].filter(Boolean).join("; ");
      } else {
        settlementChecked = true;
        if (summary.billingFailures.length) {
          billingError = [eventError, ...summary.billingFailures].filter(Boolean).join("; ");
        }
      }
    } catch (e) {
      billingError = [eventError, e instanceof Error ? e.message : "billing failed"].filter(Boolean).join("; ");
    }
  }

  revalidatePath("/storage");
  return { ok: true as const, raised, billingError, settlementChecked, overbilledNote };
}

/* -------------------------------------------------------- handling events */

const handlingEventSchema = z.object({
  let_id: z.string().uuid(),
  event_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick the event date"),
  kind: z.enum(["in", "out", "access"]),
  amount: z.coerce.number().positive("Enter the handling charge"),
  notes: z.string().trim().max(500).optional().or(z.literal("")),
});

export type HandlingEventInput = z.infer<typeof handlingEventSchema>;

/** Record a handling event (in/out/access). It bills on the next invoice the
 *  engine raises whose period covers its date. */
export async function recordHandlingEventAction(input: HandlingEventInput) {
  const parsed = handlingEventSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const v = parsed.data;
  const { sb, userId } = await actor();
  if (!userId) return { ok: false as const, error: "Not signed in." };

  const { data: let_ } = await sb
    .from("storage_lets")
    .select("id, client_id, start_date, end_date, billing_model")
    .eq("id", v.let_id)
    .single();
  if (!let_) return { ok: false as const, error: "Let not found." };
  if ((let_ as { billing_model?: string }).billing_model !== "crate_daily") {
    return { ok: false as const, error: "Handling fees apply to crate storage only — containers have none." };
  }
  // An ended let has raised (or is about to raise) its final settlement — a
  // late event would sit unbilled forever (the engine never revisits it).
  if (let_.end_date) {
    return { ok: false as const, error: "This let has ended and billing is settled — add one-off charges in Zoho instead." };
  }
  if (v.event_date < let_.start_date) return { ok: false as const, error: "Event can't be before the let started." };
  if (v.event_date > UK_TODAY()) return { ok: false as const, error: "The event date can't be in the future." };

  // Handling is a FIXED pass-through of Sandys' charge (no markup) — pin the
  // amount to the rate card server-side rather than trusting the posted value.
  const rates = await getStorageRates(sb);
  const { error } = await sb.from("storage_handling_events").insert({
    let_id: v.let_id,
    client_id: let_.client_id,
    event_date: v.event_date,
    kind: v.kind,
    amount: rates.handlingEventInc,
    notes: v.notes || null,
    created_by: userId,
  } as never);
  if (error) return { ok: false as const, error: error.message };
  revalidatePath("/storage");
  return { ok: true as const };
}

/** Remove a mis-recorded handling event — only while it hasn't billed. The
 *  unbilled predicate rides the delete itself (and the DELETE RLS policy), so
 *  a concurrent billing run can never race us into removing an invoiced
 *  charge — the delete simply hits 0 rows and we say so honestly. */
export async function deleteHandlingEventAction(eventId: string) {
  if (!z.string().uuid().safeParse(eventId).success) return { ok: false as const, error: "Event not found." };
  const { sb, userId } = await actor();
  if (!userId) return { ok: false as const, error: "Not signed in." };
  const { data: deleted, error } = await sb
    .from("storage_handling_events")
    .delete()
    .eq("id", eventId)
    .is("billed_invoice_id", null)
    .select("id");
  if (error) return { ok: false as const, error: error.message };
  if (!deleted?.length) {
    return {
      ok: false as const,
      error: "Could not remove it — it may have just been billed, or it was already removed. Check the invoice list.",
    };
  }
  revalidatePath("/storage");
  return { ok: true as const };
}

/** Edit a let. Rate/notes change freely (future periods bill at the new rate);
 *  start_date/rate_period are locked once invoices exist — the billed periods
 *  are anchored to them and re-anchoring would corrupt the invoice history. */
const editLetSchema = z.object({
  rate: optNum,
  rate_period: z.enum(["week", "month", "day"]),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Multi-brand override only — absent means leave the stamp alone. */
  brand: z.string().trim().optional().or(z.literal("")),
  notes: z.string().trim().max(2000).optional().or(z.literal("")),
});
export type EditLetInput = z.infer<typeof editLetSchema>;

export async function editLetAction(letId: string, input: EditLetInput) {
  const parsed = editLetSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const v = parsed.data;
  const { sb, userId } = await actor();
  if (!userId) return { ok: false as const, error: "Not signed in." };

  const { data: row } = await sb
    .from("storage_lets")
    .select("start_date, rate_period, end_date, billing_model, rate")
    .eq("id", letId)
    .single();
  if (!row) return { ok: false as const, error: "Let not found." };

  // The billing model is frozen at creation — a crate let bills a day rate,
  // a period let never does. Switching would corrupt the engine's routing.
  const isCrate = (row as { billing_model?: string }).billing_model === "crate_daily";
  if (isCrate && v.rate_period !== "day") {
    return { ok: false as const, error: "Crate storage bills a day rate — the period can't change." };
  }
  if (!isCrate && v.rate_period === "day") {
    return { ok: false as const, error: "Day rates are for crate storage only." };
  }

  const anchorsChanged = v.start_date !== row.start_date || v.rate_period !== row.rate_period;
  const newRate = v.rate === "" || v.rate == null ? null : v.rate;
  // A crate let must always carry a positive day rate — clearing it would make
  // the engine silently skip the let (rate > 0 filter), including its minimum.
  if (isCrate && (newRate == null || newRate <= 0)) {
    return { ok: false as const, error: "Crate storage needs a positive day rate." };
  }
  const storedRate = row.rate == null ? null : Number(row.rate);
  const rateChanged =
    newRate == null || storedRate == null ? newRate !== storedRate : Math.abs(newRate - storedRate) > 0.005;
  if (anchorsChanged || (isCrate && rateChanged)) {
    const { count } = await sb
      .from("storage_invoices")
      .select("id", { count: "exact", head: true })
      .eq("let_id", letId);
    if ((count ?? 0) > 0) {
      if (anchorsChanged) {
        return {
          ok: false as const,
          error: "Invoices exist on this let — the start date and billing period are locked. Rate and notes can still change.",
        };
      }
      // Crate arrears windows bill retrospectively AT THE LET'S RATE — a
      // mid-let rate change would reprice days the customer has already used
      // under the signed schedule. Period lets are safe (in advance; future
      // periods simply bill at the new rate).
      return {
        ok: false as const,
        error:
          "Invoices exist on this let — the day rate is locked (open arrears windows bill at the let's rate). End the let and start a new one at the new rate.",
      };
    }
  }
  if (row.end_date && v.start_date > row.end_date) {
    return { ok: false as const, error: "Start date can't be after the end date." };
  }

  const patch: {
    rate: number | null;
    rate_period: string;
    start_date: string;
    notes: string | null;
    brand?: string;
  } = {
    rate: v.rate === "" || v.rate == null ? null : v.rate,
    rate_period: v.rate_period,
    start_date: v.start_date,
    notes: v.notes || null,
  };
  // GATE 12 — the brand stamp is overridable post-creation (attribution only
  // this gate, PRD §11.10 — rates and billing carry no brand). Single-brand
  // mode: the selector never rendered, whatever arrived is ignored and the
  // column stays untouched. Multi-brand: validated against active brands.
  if (v.brand) {
    // A failed brands read refuses rather than silently dropping the office's
    // brand override on the floor (swallowed [], the patch just omitted it).
    const brandsRes = await listActiveBrandsForWrite(sb);
    if (!brandsRes.ok) return { ok: false as const, error: brandsRes.error };
    const activeBrands = brandsRes.brands;
    if (activeBrands.length > 1) {
      if (!activeBrands.some((b) => b.slug === v.brand)) {
        return { ok: false as const, error: "Choose which brand this let belongs to." };
      }
      patch.brand = v.brand;
    }
  }

  const { error } = await sb.from("storage_lets").update(patch).eq("id", letId);
  if (error) return { ok: false as const, error: error.message };
  revalidatePath("/storage");
  return { ok: true as const };
}

/** Reopen an accidentally-ended let (audit gap: ending was one-way). */
export async function reopenLetAction(letId: string) {
  const { sb, userId } = await actor();
  if (!userId) return { ok: false as const, error: "Not signed in." };
  const { data: row } = await sb
    .from("storage_lets")
    .select("unit_id, end_date, billing_model")
    .eq("id", letId)
    .single();
  if (!row) return { ok: false as const, error: "Let not found." };
  if (!row.end_date) return { ok: false as const, error: "This let is already open." };

  // Crate billing settles to the exact release day (unbilled days + handling
  // out on the final invoice) — reopening after ANY invoice exists would
  // corrupt that day-exact history. Period lets bill whole periods in
  // advance, so reopening them stays safe; so does a crate with no invoices.
  if ((row as { billing_model?: string }).billing_model === "crate_daily") {
    const { count, error: cntErr } = await sb
      .from("storage_invoices")
      .select("id", { count: "exact", head: true })
      .eq("let_id", letId);
    // Fail CLOSED — a failed count read returns null, and treating that as
    // "no invoices" would let the reopen corrupt day-exact billing history.
    if (cntErr) return { ok: false as const, error: cntErr.message };
    if ((count ?? 0) > 0) {
      return {
        ok: false as const,
        error:
          "Crate billing has already settled to the release day — reopening would corrupt the day-exact invoices. Start a new let on the unit instead.",
      };
    }
  }

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
  if (!isValidSignatureDataUri(input.signatureDataUri)) {
    return { ok: false as const, error: "The signature didn't come through — ask them to sign again." };
  }

  const { data: let_ } = await sb
    .from("storage_lets")
    .select("id, client_id, lead_id, billing_model, min_days, min_kind, brand")
    .eq("id", letId)
    .single();
  if (!let_) return { ok: false as const, error: "Let not found." };

  // Crate lets sign the crate billing schedule; containers keep the original
  // rate ack (standing policy 2026-07-22 — the ack set follows the product).
  const isCrate = (let_ as { billing_model?: string }).billing_model === "crate_daily";
  const acksOk = isCrate ? allCrateStorageAcksConfirmed(input.acks) : allStorageAcksConfirmed(input.acks);
  if (!acksOk) {
    return { ok: false as const, error: "Tick each confirmation with the customer first." };
  }

  // The company the lien tick-box names — the party the customer grants the
  // right to dispose of or sell their stored goods to. This is the path most
  // storage agreements actually take (in person, on the crew device), and it
  // named the DEFAULT brand for every brand: a second brand's customer signing
  // in front of the crew was granting Marley Moves rights over their goods,
  // with the rendered and recorded wording agreeing because BOTH were wrong.
  //
  // Resolved through getBrandOrDefault → pageTheme from the let's PERSISTED
  // brand column, exactly as app/s/[token]/actions.ts does for the remote path,
  // so the two channels record identical wording for the same let.
  // components/storage/manage-let-dialog.tsx renders from the same slug and
  // refuses to open the signing panel when it cannot resolve the name, so it
  // can never show one company here and record another.
  const company = pageTheme(await getBrandOrDefault(sb, let_.brand)).name;

  // Evidence: store the exact ack WORDING beside the ticked keys. Derived
  // server-side from the same sources the dialog renders (this brand's name +
  // the let's frozen min_kind/min_days + the live rate-card handling figure —
  // mirrors /s), so the record shows what was agreed even after the rate card
  // changes.
  let ackDefs: ReadonlyArray<{ key: string; label: string }> = storageAcks(company);
  if (isCrate) {
    const rates = await getStorageRates(sb);
    const l = let_ as { min_days?: number | null; min_kind?: string | null };
    ackDefs = crateStorageAcks(
      { kind: l.min_kind, days: Number(l.min_days ?? rates.crateMinDays) },
      gbpInc(rates.handlingEventInc),
      company,
    );
  }
  const ackLabels = Object.fromEntries(ackDefs.map((a) => [a.key, a.label]));

  const { error } = await sb.from("signatures").insert({
    kind: "storage",
    storage_let_id: let_.id,
    client_id: let_.client_id,
    lead_id: let_.lead_id,
    signer_name: name,
    signature_data: input.signatureDataUri,
    method: "drawn",
    channel: "in_person",
    acknowledgments: isCrate ? normalizeCrateStorageAcks(input.acks) : normalizeStorageAcks(input.acks),
    ack_labels: ackLabels,
    ...termsSnapshot("storage-terms"),
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

/** Email the remote signing link to the storage client (the "send" counterpart
 *  to copy-link). Mints the token lazily, wraps the /s/<token> URL in the
 *  branded shell, and logs to Comms via the shared dispatcher. */
export async function emailStorageSignLinkAction(letId: string): Promise<DispatchCommResult> {
  const { sb, userId } = await actor();
  if (!userId) return { ok: false, error: "Not signed in." };

  const { data: row } = await sb
    .from("storage_lets")
    .select("sign_token, client_id, lead_id, brand")
    .eq("id", letId)
    .single();
  if (!row) return { ok: false, error: "Let not found." };

  const { data: client } = await sb
    .from("clients")
    .select("email, display_name")
    .eq("id", row.client_id)
    .maybeSingle();
  const email = client?.email ?? null;
  if (!email) {
    return { ok: false, error: "No email on file for this client — add one on the client record first." };
  }

  let token = row.sign_token as string | null;
  if (!token) {
    token = randomBytes(18).toString("base64url");
    const { error } = await sb.from("storage_lets").update({ sign_token: token } as never).eq("id", letId);
    if (error) return { ok: false, error: error.message };
  }
  const url = `https://ops.marleymoves.co.uk/s/${token}`;

  // The let's brand drives the shell chrome, copy and From (multi-brand PRD
  // §3.5); marley/absent composes today's exact email.
  const signBrand = await getBrandOrDefault(sb, (row as { brand?: string }).brand ?? DEFAULT_BRAND);
  const signIsDefault = signBrand.slug === DEFAULT_BRAND;
  const signBrandName = signIsDefault ? "Marley Moves" : signBrand.name;
  const signBrandPhone = signIsDefault ? "01747 637070" : (signBrand.phone ?? "01747 637070");
  const firstName = (client?.display_name ?? "").trim().split(/\s+/)[0] || undefined;
  const bodyHtml = brandedEmailHtml({
    preheader: `Your ${signBrandName} storage agreement is ready to review and sign.`,
    greeting: firstName,
    headline: "Your storage agreement",
    paragraphs: [
      `Your storage agreement with ${signBrandName} is ready. Please review the terms and add your signature using the button below. It only takes a minute.`,
      `Any questions, just reply to this email or call us on ${signBrandPhone}.`,
    ],
    cta: { label: "Review & sign your agreement", url },
    brand: signBrand,
  });

  const result = await dispatchComm(sb, userId, {
    channel: "email",
    to: email,
    // A non-default brand fronts its own door — dispatch/send default to the
    // Marley house identity when From is absent, which must never happen here.
    from: signIsDefault ? FROM : helloFromFor(signBrand),
    brand: signBrand,
    subject: `Your ${signBrandName} storage agreement`,
    bodyText: `Your storage agreement is ready to sign: ${url}`,
    bodyHtml,
    clientId: row.client_id,
    leadId: (row.lead_id as string | null) ?? undefined,
  });

  if ("ok" in result && result.ok) revalidatePath("/storage");
  return result;
}
