"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  allCrateStorageAcksConfirmed,
  allStorageAcksConfirmed,
  crateStorageAcks,
  isValidSignatureDataUri,
  normalizeCrateStorageAcks,
  normalizeStorageAcks,
  STORAGE_ACKS,
} from "@/lib/signatures";
import { termsSnapshot } from "@/lib/legal/documents";
import { getStorageRates, gbpInc } from "@/lib/storage-rates";
import { sendOpsAlert } from "@/lib/comms/dispatch";
import { escapeHtml } from "@/lib/comms/escape-html";

/** PUBLIC — the customer signs their storage agreement at /s/<token>. The
 *  unguessable token is the credential; one signature per let (unique index),
 *  so a replay is a clean success. */
export async function signStorageAgreementRemoteAction(
  token: string,
  fullName: string,
  acks: Record<string, boolean>,
  signatureImage?: string | null,
): Promise<{ ok: boolean; error?: string }> {
  if (!/^[\w-]{10,64}$/.test(token)) return { ok: false, error: "This link is no longer valid." };
  const name = fullName.trim();
  if (name.length < 2) return { ok: false, error: "Type your full name to sign the agreement." };

  const admin = createAdminClient();
  const { data: let_ } = await admin
    .from("storage_lets")
    .select("id, client_id, lead_id, billing_model, min_days")
    .eq("sign_token", token)
    .maybeSingle();
  if (!let_) return { ok: false, error: "This link is no longer valid." };

  // The ack set follows the product (crate billing schedule vs container rate).
  const isCrate = (let_ as { billing_model?: string }).billing_model === "crate_daily";
  const acksOk = isCrate ? allCrateStorageAcksConfirmed(acks) : allStorageAcksConfirmed(acks);
  if (!acksOk) return { ok: false, error: "Please tick each confirmation box." };

  // Evidence: store the exact ack WORDING beside the ticked keys — the same
  // derivation the /s page renders (the let's frozen min_days + the live
  // rate-card handling figure), so the record shows what was agreed even
  // after the rate card changes.
  let ackDefs: ReadonlyArray<{ key: string; label: string }> = STORAGE_ACKS;
  if (isCrate) {
    const rates = await getStorageRates(admin);
    const minDays = Number((let_ as { min_days?: number | null }).min_days ?? rates.crateMinDays);
    ackDefs = crateStorageAcks(minDays, gbpInc(rates.handlingEventInc));
  }
  const ackLabels = Object.fromEntries(ackDefs.map((a) => [a.key, a.label]));

  const h = await headers();
  const ip = (h.get("x-forwarded-for") ?? "").split(",")[0].trim() || null;

  const { error } = await admin.from("signatures").insert({
    kind: "storage",
    storage_let_id: let_.id,
    client_id: let_.client_id,
    lead_id: let_.lead_id,
    signer_name: name,
    signature_data: isValidSignatureDataUri(signatureImage) ? signatureImage : null,
    method: "typed",
    channel: "remote",
    acknowledgments: isCrate ? normalizeCrateStorageAcks(acks) : normalizeStorageAcks(acks),
    ack_labels: ackLabels,
    ...termsSnapshot("storage-terms"),
    ip,
    user_agent: h.get("user-agent"),
  } as never);
  if (error && error.code !== "23505") {
    // Deliberately NO message. The caller already holds the brand-resolved
    // phone — `agreement-form.tsx` renders `res.error ?? "Something went wrong
    // — call ${phone}."` from `pageTheme(getBrandOrDefault(let_.brand))` — and
    // that component's own prop note says this number is "what a customer reads
    // at the moment their signature has just failed", which is a poor moment to
    // hand them another company's office. A hardcoded number here silently
    // OUTRANKED that fallback, so a storage customer of one brand was shown a
    // different brand's office number on exactly that screen. Returning no
    // error lets the resolved fallback win.
    return { ok: false };
  }

  if (!error) {
    await sendOpsAlert("Storage agreement signed online", [
      `<strong>${escapeHtml(name)}</strong> signed their storage agreement remotely.`,
      `The Documents register and the unit's card now show it.`,
    ]);
  }
  revalidatePath(`/s/${token}`);
  return { ok: true };
}
