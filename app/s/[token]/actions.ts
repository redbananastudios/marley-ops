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
  storageAcks,
} from "@/lib/signatures";
import { termsSnapshot } from "@/lib/legal/documents";
import { getBrandOrDefault } from "@/lib/brand";
import { pageTheme } from "@/lib/brand-page-theme";
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
    .select("id, client_id, lead_id, billing_model, min_days, min_kind, brand")
    .eq("sign_token", token)
    .maybeSingle();
  if (!let_) return { ok: false, error: "This link is no longer valid." };

  // The ack set follows the product (crate billing schedule vs container rate).
  const isCrate = (let_ as { billing_model?: string }).billing_model === "crate_daily";
  const acksOk = isCrate ? allCrateStorageAcksConfirmed(acks) : allStorageAcksConfirmed(acks);
  if (!acksOk) return { ok: false, error: "Please tick each confirmation box." };

  // The company the lien tick-box names — the party the customer is granting
  // the right to dispose of or sell their stored goods to. Resolved from the
  // LET's own brand through the SAME two functions app/s/[token]/page.tsx uses
  // (getBrandOrDefault → pageTheme), from the same column, so what was rendered
  // and what is recorded cannot drift.
  //
  // This block used to re-derive the labels from the UNBRANDED module
  // constants. A second brand's customer therefore READ their own company's
  // name in the lien clause, ticked it, signed — and this row RECORDED the
  // default company's name instead. `signatures.ack_labels` is the sole record
  // of what was agreed, so the divergence was invisible until someone had to
  // produce the agreement years later.
  const company = pageTheme(await getBrandOrDefault(admin, let_.brand)).name;

  // Evidence: store the exact ack WORDING beside the ticked keys — the same
  // derivation the /s page renders (this brand's name + the let's frozen
  // min_kind/min_days + the live rate-card handling figure), so the record
  // shows what was agreed even after the rate card changes.
  let ackDefs: ReadonlyArray<{ key: string; label: string }> = storageAcks(company);
  if (isCrate) {
    const rates = await getStorageRates(admin);
    const l = let_ as { min_days?: number | null; min_kind?: string | null };
    ackDefs = crateStorageAcks(
      { kind: l.min_kind, days: Number(l.min_days ?? rates.crateMinDays) },
      gbpInc(rates.handlingEventInc),
      company,
    );
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
