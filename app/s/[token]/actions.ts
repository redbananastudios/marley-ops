"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  allStorageAcksConfirmed,
  isValidSignatureDataUri,
  normalizeStorageAcks,
  TERMS_VERSION,
} from "@/lib/signatures";
import { sendOpsAlert } from "@/lib/comms/dispatch";

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
  if (!allStorageAcksConfirmed(acks)) return { ok: false, error: "Please tick each confirmation box." };

  const admin = createAdminClient();
  const { data: let_ } = await admin
    .from("storage_lets")
    .select("id, client_id, lead_id")
    .eq("sign_token", token)
    .maybeSingle();
  if (!let_) return { ok: false, error: "This link is no longer valid." };

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
    acknowledgments: normalizeStorageAcks(acks),
    terms_version: TERMS_VERSION,
    ip,
    user_agent: h.get("user-agent"),
  } as never);
  if (error && error.code !== "23505") {
    return { ok: false, error: "Something went wrong — please call 01747 637070." };
  }

  if (!error) {
    await sendOpsAlert("Storage agreement signed online", [
      `<strong>${name}</strong> signed their storage agreement remotely.`,
      `The Documents register and the unit's card now show it.`,
    ]);
  }
  revalidatePath(`/s/${token}`);
  return { ok: true };
}
