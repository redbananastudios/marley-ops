"use server";

/**
 * Office-side date confirmation (Payments Policy v2 §5A) — the two staff
 * entry points behind the DateConfirmStatus chip:
 *
 *  - confirmDateInPersonAction  the customer is on the phone / in the office:
 *    run the SAME pipeline as the public /q card (CAS, signature evidence,
 *    commitment invoice, email, timeline) with channel 'in_person' and the
 *    collecting staff member recorded.
 *  - getDateConfirmLinkAction   mint/fetch the customer's /q link (the confirm
 *    card lives on the same page as their payment view) for copy/send.
 *
 * Both are office-gated server-side (requireOfficeProfile — crew denied) and
 * run on the admin client, mirroring app/actions/crew-signatures.ts.
 */

import { revalidatePath } from "next/cache";
import { requireOfficeProfile } from "@/lib/ai/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidSignatureDataUri } from "@/lib/signatures";
import {
  acceptUrlFor,
  confirmMoveDate,
  ensureAcceptToken,
  type DateConfirmOutcome,
} from "@/lib/quote/accept-flow";

/** The lead's money quote — the most recently accepted one. */
async function findAcceptedQuoteId(
  sb: ReturnType<typeof createAdminClient>,
  leadId: string,
): Promise<string | null> {
  const { data } = await sb
    .from("quotes")
    .select("id")
    .eq("lead_id", leadId)
    .eq("status", "accepted")
    .order("accepted_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.id ?? null;
}

export async function confirmDateInPersonAction(
  leadId: string,
  input: {
    signerName: string;
    acks: Record<string, boolean>;
    /** Finger-drawn PNG from the pad; omit for a typed-name confirmation. */
    signatureDataUri?: string | null;
    /** Script rendering of the typed name (evidence image on the typed path). */
    typedSignatureImage?: string | null;
  },
): Promise<DateConfirmOutcome> {
  const profile = await requireOfficeProfile();
  if (!profile) return { ok: false, error: "Not signed in." };

  const sb = createAdminClient();
  const quoteId = await findAcceptedQuoteId(sb, leadId);
  if (!quoteId) return { ok: false, error: "No accepted quote on this lead." };

  const drawn = isValidSignatureDataUri(input.signatureDataUri);
  const result = await confirmMoveDate(sb, quoteId, {
    signerName: input.signerName,
    acks: input.acks,
    channel: "in_person",
    method: drawn ? "drawn" : "typed",
    signatureImage: drawn ? input.signatureDataUri : (input.typedSignatureImage ?? null),
    collectedBy: profile.id,
  });

  if (result.ok) {
    revalidatePath(`/leads/${leadId}`);
    revalidatePath("/bookings");
  }
  return result;
}

/** Copy-able confirmation link: the customer's /q page (the confirm card
 *  renders there once the deposit is paid). Mints the accept token lazily. */
export async function getDateConfirmLinkAction(
  leadId: string,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const profile = await requireOfficeProfile();
  if (!profile) return { ok: false, error: "Not signed in." };

  const sb = createAdminClient();
  const quoteId = await findAcceptedQuoteId(sb, leadId);
  if (!quoteId) return { ok: false, error: "No accepted quote on this lead." };

  const token = await ensureAcceptToken(sb, quoteId);
  if (!token) return { ok: false, error: "Could not create the confirmation link." };
  return { ok: true, url: acceptUrlFor(token) };
}
