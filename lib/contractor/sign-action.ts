"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { isValidSignatureDataUri } from "@/lib/signatures";
import {
  CONTRACTOR_AGREEMENT_VERSION,
  allContractorAcksConfirmed,
  normalizeContractorAcks,
} from "./agreement";

const schema = z.object({
  name: z.string().trim().min(2, "Type your full name to sign.").max(120),
  acks: z.record(z.string(), z.boolean()),
  signatureImage: z.string().max(200_000).optional().nullable(),
});

/**
 * The signed-in worker signs the current contractor agreement — once per version.
 * Only contractors (crew / estimator) sign; admins are the payer. The insert is
 * scoped by RLS to `profile_id = auth.uid()`, and the (profile_id, version)
 * unique index makes a re-sign a clean idempotent success.
 */
export async function signContractorAgreementAction(input: z.infer<typeof schema>) {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const profile = await getSessionProfile();
  if (!profile) return { ok: false as const, error: "Not signed in." };
  if (profile.active === false) return { ok: false as const, error: "This login is inactive." };
  if (profile.role !== "crew" && profile.role !== "estimator") {
    return { ok: false as const, error: "Only contractors sign this agreement." };
  }
  const { name, acks, signatureImage } = parsed.data;
  if (!allContractorAcksConfirmed(acks)) return { ok: false as const, error: "Please tick each confirmation box." };

  const sb = await createClient();
  const { data: staffRow } = await sb.from("staff").select("id").eq("profile_id", profile.id).maybeSingle();

  const h = await headers();
  const ip = (h.get("x-forwarded-for") ?? "").split(",")[0].trim() || null;

  const { error } = await sb.from("contractor_agreements").insert({
    profile_id: profile.id,
    staff_id: staffRow?.id ?? null,
    role: profile.role,
    agreement_version: CONTRACTOR_AGREEMENT_VERSION,
    signer_name: name.trim(),
    signature_data: isValidSignatureDataUri(signatureImage) ? signatureImage : null,
    acknowledgments: normalizeContractorAcks(acks),
    ip,
    user_agent: h.get("user-agent"),
  });
  // 23505 = already signed this version → treat as success (idempotent replay).
  if (error && error.code !== "23505") return { ok: false as const, error: error.message };

  revalidatePath("/my-jobs");
  revalidatePath("/my-jobs/pay");
  revalidatePath("/my-jobs/agreement");
  revalidatePath("/settings");
  revalidatePath("/documents");
  return { ok: true as const };
}
