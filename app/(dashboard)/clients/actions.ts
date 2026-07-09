"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { findExistingClient } from "@/lib/leads/resolver";
import { ensureLeadForClient } from "@/lib/leads/for-client";
import { normalizeEmail, normalizePhone } from "@/lib/leads/phone";

async function actor() {
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  return { sb, userId: user?.id ?? null };
}

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
  const companyName = clean(input.companyName);
  const firstName = clean(input.firstName);
  const lastName = clean(input.lastName);

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
        postcode_home: clean(addr.postcode),
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

/**
 * "Book a survey" from a client record: phone customers are clients first, but
 * every booking hangs off a lead — this returns the client's open enquiry or
 * opens one (with the phone source they told us), ready to preselect in the
 * survey diary.
 */
export async function createLeadForClientAction(clientId: string, entryChannel: string) {
  const ALLOWED = ["phone_google", "phone_facebook", "phone_referral", "manual", "referral"];
  const channel = ALLOWED.includes(entryChannel) ? entryChannel : "manual";
  const { sb, userId } = await actor();
  const res = await ensureLeadForClient(sb, clientId, userId, channel);
  if (!res.ok) return res;
  revalidatePath("/leads");
  revalidatePath(`/clients/${clientId}`);
  return res;
}
