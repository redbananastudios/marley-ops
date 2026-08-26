"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { findExistingClient } from "@/lib/leads/resolver";
import { ensureLeadForClient } from "@/lib/leads/for-client";
import { DEFAULT_BRAND, listActiveBrands } from "@/lib/brand";
import { normalizeEmail, normalizePhone } from "@/lib/leads/phone";
import { formatPersonNameOrNull, formatUkPostcodeOrNull } from "@/lib/leads/format";

async function actor() {
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  return { sb, userId: user?.id ?? null };
}

/** Archiving a client hides a shared record other rows (leads, quotes, signatures)
 *  point at — an admin-only action, mirroring setStaffActiveAction in the settings
 *  actions. Editing the record stays office-level (same gate as createClientAction). */
async function requireAdmin() {
  const profile = await getSessionProfile();
  if (!profile) return { error: "Not signed in." as const };
  if (profile.role !== "admin") return { error: "Admins only." as const };
  const sb = await createClient();
  return { sb, userId: profile.id };
}

// A lead is "live" while it's anywhere in the active pipeline — terminal states
// (completed / declined) don't block archiving. Mirrors the OPEN set the client
// detail page uses to find a reusable enquiry.
const LIVE_LEAD_STATUSES = ["website_enquiry", "survey_booked", "quoted", "provisional", "confirmed"] as const;

/** Live dedupe check for the Add-client dialog. Read-only. */
export async function checkClientDuplicateAction(input: { phone?: string; email?: string }) {
  const { sb } = await actor();
  const match = await findExistingClient(sb, input);
  if (!match) return { matched: false as const };
  return {
    matched: true as const,
    clientName: match.client.display_name,
    previousLeadCount: match.previousLeadCount,
  };
}

interface AddressInput {
  line1?: string;
  town?: string;
  county?: string;
  postcode?: string;
  country?: string;
}

export interface CreateClientInput {
  isCompany?: boolean;
  companyName?: string;
  businessNumber?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  secondaryEmails?: string[];
  phone?: string;
  altPhone?: string;
  address?: AddressInput;
  notes?: string;
}

const clean = (s?: string) => {
  const t = s?.trim();
  return t ? t : null;
};

/** Create a client directly (manual entry) with the full record. Dedupes on
 *  phone/email — if a live client already matches, returns that one rather than a
 *  duplicate (we don't overwrite an existing client from the quick-add form). */
export async function createClientAction(input: CreateClientInput) {
  const isCompany = !!input.isCompany;
  // Company names stay as typed ("iSmash", "ABC Ltd"); person names are
  // normalised ("paul betty" → "Paul Betty") like every other write path.
  const companyName = clean(input.companyName);
  const firstName = formatPersonNameOrNull(input.firstName);
  const lastName = formatPersonNameOrNull(input.lastName);

  // Resolved label: company name when a company, else "First Last".
  const personName = [firstName, lastName].filter(Boolean).join(" ").trim() || null;
  const displayName = (isCompany ? companyName : personName) ?? companyName ?? personName;
  if (!displayName) return { ok: false as const, error: "A name is required." };

  const { sb, userId } = await actor();

  // Dedupe first — attach to an existing live client rather than duplicating.
  const existing = await findExistingClient(sb, { phone: input.phone, email: input.email });
  if (existing) {
    revalidatePath("/clients");
    return { ok: true as const, clientId: existing.client.id, matched: true as const };
  }

  const addr = input.address ?? {};
  const secondaryEmails = (input.secondaryEmails ?? [])
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  try {
    const { data, error } = await sb
      .from("clients")
      .insert({
        display_name: displayName,
        is_company: isCompany,
        company_name: companyName,
        business_number: clean(input.businessNumber),
        first_name: firstName,
        last_name: lastName,
        email: normalizeEmail(input.email),
        secondary_emails: secondaryEmails,
        phone_raw: clean(input.phone),
        phone_e164: normalizePhone(input.phone),
        alt_phone: clean(input.altPhone),
        address_line1: clean(addr.line1),
        town: clean(addr.town),
        county: clean(addr.county),
        postcode_home: formatUkPostcodeOrNull(addr.postcode),
        country: clean(addr.country) ?? "United Kingdom",
        notes: clean(input.notes),
      })
      .select("id")
      .single();

    if (error) {
      // Lost a race on the partial-unique index — re-resolve to the live client.
      const retry = await findExistingClient(sb, { phone: input.phone, email: input.email });
      if (retry) {
        revalidatePath("/clients");
        return { ok: true as const, clientId: retry.client.id, matched: true as const };
      }
      const dupe = /duplicate|unique/i.test(error.message);
      return {
        ok: false as const,
        error: dupe ? "That phone or email already belongs to another client." : error.message,
      };
    }

    await sb.from("activities").insert({
      client_id: data.id,
      actor_id: userId,
      type: "note",
      summary: "Client added manually",
    });

    revalidatePath("/clients");
    return { ok: true as const, clientId: data.id, matched: false as const };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : "Could not add client." };
  }
}

/** Edit an existing client's full record. Office-level (same gate as
 *  createClientAction) — an estimator maintaining a client is expected. Recomputes
 *  the display_name from the name fields exactly as create does, and carries the
 *  same phone/email unique-collision handling: the partial-unique index rejects a
 *  phone/email already held by ANOTHER live client, which we surface as a friendly
 *  message rather than a raw Postgres error. Editing a client to keep its own
 *  phone/email never collides (the index excludes the row's own value). */
export async function updateClientAction(id: string, input: CreateClientInput) {
  if (!id) return { ok: false as const, error: "Missing client." };

  const isCompany = !!input.isCompany;
  // Same normalisation as createClientAction — person names only.
  const companyName = clean(input.companyName);
  const firstName = formatPersonNameOrNull(input.firstName);
  const lastName = formatPersonNameOrNull(input.lastName);

  const personName = [firstName, lastName].filter(Boolean).join(" ").trim() || null;
  const displayName = (isCompany ? companyName : personName) ?? companyName ?? personName;
  if (!displayName) return { ok: false as const, error: "A name is required." };

  const { sb, userId } = await actor();

  const addr = input.address ?? {};
  const secondaryEmails = (input.secondaryEmails ?? [])
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  try {
    const { error } = await sb
      .from("clients")
      .update({
        display_name: displayName,
        is_company: isCompany,
        company_name: companyName,
        business_number: clean(input.businessNumber),
        first_name: firstName,
        last_name: lastName,
        email: normalizeEmail(input.email),
        secondary_emails: secondaryEmails,
        phone_raw: clean(input.phone),
        phone_e164: normalizePhone(input.phone),
        alt_phone: clean(input.altPhone),
        address_line1: clean(addr.line1),
        town: clean(addr.town),
        county: clean(addr.county),
        postcode_home: formatUkPostcodeOrNull(addr.postcode),
        country: clean(addr.country) ?? "United Kingdom",
        notes: clean(input.notes),
      })
      .eq("id", id);

    if (error) {
      const dupe = /duplicate|unique/i.test(error.message);
      return {
        ok: false as const,
        error: dupe ? "That phone or email already belongs to another client." : error.message,
      };
    }

    await sb.from("activities").insert({
      client_id: id,
      actor_id: userId,
      type: "note",
      summary: "Client details updated",
    });

    revalidatePath("/clients");
    revalidatePath(`/clients/${id}`);
    return { ok: true as const, clientId: id };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : "Could not update client." };
  }
}

/** Archive / restore a client. Flips is_active (the list query filters on it), so
 *  we never hard-delete a record linked leads, quotes and signatures point at.
 *  Admin-only, mirroring setStaffActiveAction. Archiving is money-aware: it is
 *  BLOCKED while the client still has a live enquiry or an accepted quote, so an
 *  in-flight job can't be hidden out from under its paperwork. Restoring (active =
 *  true) is always allowed. */
export async function setClientActiveAction(id: string, isActive: boolean) {
  if (!id) return { ok: false as const, error: "Missing client." };
  const ctx = await requireAdmin();
  if ("error" in ctx) return { ok: false as const, error: ctx.error };
  const { sb } = ctx;

  if (!isActive) {
    const [{ data: liveLeads }, { data: acceptedQuotes }] = await Promise.all([
      sb.from("leads").select("id").eq("client_id", id).in("status", LIVE_LEAD_STATUSES).limit(1),
      sb.from("quotes").select("id").eq("client_id", id).eq("status", "accepted").limit(1),
    ]);
    if (liveLeads && liveLeads.length) {
      return {
        ok: false as const,
        error: "This client has a live enquiry. Close or complete it before archiving them.",
      };
    }
    if (acceptedQuotes && acceptedQuotes.length) {
      return {
        ok: false as const,
        error: "This client has an accepted quote. Archiving is blocked so the job and its paperwork stay linked.",
      };
    }
  }

  const { error } = await sb.from("clients").update({ is_active: isActive }).eq("id", id);
  if (error) return { ok: false as const, error: error.message };

  revalidatePath("/clients");
  revalidatePath(`/clients/${id}`);
  return { ok: true as const };
}

/**
 * "Book a survey" from a client record: phone customers are clients first, but
 * every booking hangs off a lead — this returns the client's open enquiry or
 * opens one (with the phone source they told us), ready to preselect in the
 * survey diary.
 */
export async function createLeadForClientAction(clientId: string, entryChannel: string, brand?: string) {
  const ALLOWED = ["phone_google", "phone_facebook", "phone_referral", "manual", "referral"];
  const channel = ALLOWED.includes(entryChannel) ? entryChannel : "manual";
  const { sb, userId } = await actor();
  // GATE 11 — the enquiry's brand, resolved SERVER-SIDE and never trusted from
  // the client (mirrors createAppointment's bare-client path). Single-brand
  // mode: the callers' pickers never rendered, so whatever arrived is ignored
  // and DEFAULT_BRAND is written — today's behaviour. Multi-brand mode:
  // required with NO default — nothing can be inferred about which brand a
  // phone customer rang. Validated against listActiveBrands (data, not a
  // constant list).
  const activeBrands = await listActiveBrands(sb);
  let leadBrand: string = DEFAULT_BRAND;
  if (activeBrands.length > 1) {
    const picked = brand && activeBrands.some((b) => b.slug === brand) ? brand : null;
    if (!picked) return { ok: false as const, error: "Choose which brand this enquiry is for." };
    leadBrand = picked;
  }
  const res = await ensureLeadForClient(sb, clientId, userId, channel, leadBrand);
  if (!res.ok) return res;
  revalidatePath("/leads");
  revalidatePath(`/clients/${clientId}`);
  return res;
}
