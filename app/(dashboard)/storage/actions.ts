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
  isValidSignatureDataUri,
  normalizeCrateStorageAcks,
  normalizeStorageAcks,
  TERMS_VERSION,
} from "@/lib/signatures";
import { raiseDueStorageInvoices } from "@/lib/storage/raise-storage-invoices";

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
  rate_period: z.enum(["week", "month", "day"]),
  billing_model: z.enum(["period", "crate_daily"]).default("period"),
  min_days: optNum,
  min_amount: optNum,
  /** Crate lets: record the "handling in" event at commencement (default on). */
  record_handling_in: z.boolean().optional(),
  handling_amount: optNum,
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
    if (!minDays || minDays < 1) return { ok: false as const, error: "Set the minimum-stay days." };
    if (minAmount == null || minAmount < 0) return { ok: false as const, error: "Set the minimum-stay charge." };
  } else if (v.rate_period === "day") {
    return { ok: false as const, error: "Day rates are for crate storage — pick weekly or monthly." };
  }

  // App-level guard; the partial unique index (one open let per unit) is the backstop.
  const { count } = await sb
    .from("storage_lets")
    .select("id", { count: "exact", head: true })
    .eq("unit_id", v.unit_id)
    .is("end_date", null);
  if ((count ?? 0) > 0) return { ok: false as const, error: "This unit is already occupied." };

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
      notes: v.notes || null,
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

export async function endLetAction(letId: string, endDate: string, opts?: EndLetOptions) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return { ok: false as const, error: "Pick an end date." };
  const { sb, userId } = await actor();
  if (!userId) return { ok: false as const, error: "Not signed in." };
  // The inline settlement runs on the admin client (Zoho + claim writes), so
  // gate explicitly — RLS on storage_lets covers the update but not that path.
  const office = await requireOfficeProfile();
  if (!office) return { ok: false as const, error: "Office access required." };

  const { data: row } = await sb
    .from("storage_lets")
    .select("start_date, end_date, client_id, billing_model")
    .eq("id", letId)
    .single();
  if (!row) return { ok: false as const, error: "Let not found." };
  if (row.end_date) return { ok: false as const, error: "This let is already ended." };
  if (endDate < row.start_date) return { ok: false as const, error: "End date can't be before the start date." };

  const { error } = await sb.from("storage_lets").update({ end_date: endDate }).eq("id", letId);
  if (error) return { ok: false as const, error: error.message };

  // Egress event AFTER the end date lands — an event without the release would
  // ride a future cycle invoice as a stray charge. If this insert fails the let
  // is still ended; the office adds the event from Manage and the cron settles.
  let eventError: string | undefined;
  if (
    (row as { billing_model?: string }).billing_model === "crate_daily" &&
    opts?.recordHandlingOut &&
    (opts.handlingAmount ?? 0) > 0
  ) {
    const { error: evErr } = await sb.from("storage_handling_events").insert({
      let_id: letId,
      client_id: row.client_id,
      event_date: endDate,
      kind: "out",
      amount: opts.handlingAmount,
      created_by: userId,
    } as never);
    if (evErr) eventError = `handling-out event failed (${evErr.message}) — add it from Manage`;
  }

  // Release settlement: raise the final invoice(s) now rather than waiting for
  // the 08:00 cron — the policy is "settled before goods leave". Fail-soft:
  // the claim machinery releases on failure and the cron retries tomorrow.
  let raised: { invoiceNumber: string; amount: number; kind: string }[] = [];
  let billingError: string | undefined = eventError;
  if (opts?.billNow !== false) {
    try {
      const summary = await raiseDueStorageInvoices(createAdminClient(), { todayIso: UK_TODAY(), letId });
      raised = summary.invoices.map(({ invoiceNumber, amount, kind }) => ({ invoiceNumber, amount, kind }));
      if (summary.billingFailures.length) {
        billingError = [eventError, ...summary.billingFailures].filter(Boolean).join("; ");
      }
    } catch (e) {
      billingError = [eventError, e instanceof Error ? e.message : "billing failed"].filter(Boolean).join("; ");
    }
  }

  revalidatePath("/storage");
  return { ok: true as const, raised, billingError };
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
  if (v.event_date < let_.start_date) return { ok: false as const, error: "Event can't be before the let started." };

  const { error } = await sb.from("storage_handling_events").insert({
    let_id: v.let_id,
    client_id: let_.client_id,
    event_date: v.event_date,
    kind: v.kind,
    amount: v.amount,
    notes: v.notes || null,
    created_by: userId,
  } as never);
  if (error) return { ok: false as const, error: error.message };
  revalidatePath("/storage");
  return { ok: true as const };
}

/** Remove a mis-recorded handling event — only while it hasn't billed. */
export async function deleteHandlingEventAction(eventId: string) {
  const { sb, userId } = await actor();
  if (!userId) return { ok: false as const, error: "Not signed in." };
  const { data: ev } = await sb
    .from("storage_handling_events")
    .select("id, billed_invoice_id")
    .eq("id", eventId)
    .single();
  if (!ev) return { ok: false as const, error: "Event not found." };
  if (ev.billed_invoice_id) {
    return { ok: false as const, error: "This event is already on an invoice — adjust it in Zoho instead." };
  }
  const { error } = await sb.from("storage_handling_events").delete().eq("id", eventId);
  if (error) return { ok: false as const, error: error.message };
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
    .select("start_date, rate_period, end_date, billing_model")
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
  if (!isValidSignatureDataUri(input.signatureDataUri)) {
    return { ok: false as const, error: "The signature didn't come through — ask them to sign again." };
  }

  const { data: let_ } = await sb
    .from("storage_lets")
    .select("id, client_id, lead_id, billing_model")
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

/** Email the remote signing link to the storage client (the "send" counterpart
 *  to copy-link). Mints the token lazily, wraps the /s/<token> URL in the
 *  branded shell, and logs to Comms via the shared dispatcher. */
export async function emailStorageSignLinkAction(letId: string): Promise<DispatchCommResult> {
  const { sb, userId } = await actor();
  if (!userId) return { ok: false, error: "Not signed in." };

  const { data: row } = await sb
    .from("storage_lets")
    .select("sign_token, client_id, lead_id")
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

  const firstName = (client?.display_name ?? "").trim().split(/\s+/)[0] || undefined;
  const bodyHtml = brandedEmailHtml({
    preheader: "Your Marley Moves storage agreement is ready to review and sign.",
    greeting: firstName,
    headline: "Your storage agreement",
    paragraphs: [
      "Your storage agreement with Marley Moves is ready. Please review the terms and add your signature using the button below. It only takes a minute.",
      "Any questions, just reply to this email or call us on 01747 637070.",
    ],
    cta: { label: "Review & sign your agreement", url },
  });

  const result = await dispatchComm(sb, userId, {
    channel: "email",
    to: email,
    from: FROM,
    subject: "Your Marley Moves storage agreement",
    bodyText: `Your storage agreement is ready to sign: ${url}`,
    bodyHtml,
    clientId: row.client_id,
    leadId: (row.lead_id as string | null) ?? undefined,
  });

  if ("ok" in result && result.ok) revalidatePath("/storage");
  return result;
}
