"use server";

/**
 * Claims actions (stage 2, Peter 2026-07-16). Office-only — claims carry
 * liability + money detail, same posture as invoices. The automatic open at
 * completion sign-off lives in crew-signatures.ts (crew trigger it); these are
 * the office's hands: open by hand when a customer calls, and move a claim
 * along its trail. Every material change lands on the lead timeline.
 */

import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOfficeProfile } from "@/lib/ai/auth";
import {
  CLAIM_CHANNEL_LABEL,
  CLAIM_RESOLUTION_LABEL,
  CLAIM_STATUS_LABEL,
  claimRef,
  isClaimResolution,
  isClaimStatus,
  MANUAL_CLAIM_CHANNELS,
  validateClaimUpdate,
  type ClaimChannel,
  type ClaimResolution,
  type ClaimStatus,
} from "@/lib/claims";

const uuid = z.string().uuid();

/* ------------------------------------------------------------ open by hand */

const openSchema = z.object({
  channel: z
    .string()
    .refine((c): c is ClaimChannel => (MANUAL_CLAIM_CHANNELS as readonly string[]).includes(c), {
      message: "Pick how the claim was reported.",
    }),
  description: z
    .string()
    .trim()
    .min(5, "Describe what the customer is claiming for.")
    .max(4000),
});

export async function openClaimAction(
  leadId: string,
  input: { channel: string; description: string },
): Promise<{ ok: true; claimId: string; ref: string } | { ok: false; error: string }> {
  if (!uuid.safeParse(leadId).success) return { ok: false, error: "Invalid enquiry." };
  const prof = await requireOfficeProfile();
  if (!prof) return { ok: false, error: "Not signed in." };

  const parsed = openSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the form and try again." };
  }
  const v = parsed.data;

  const admin = createAdminClient();
  const { data: lead } = await admin
    .from("leads")
    .select("id, name, client_id")
    .eq("id", leadId)
    .maybeSingle();
  if (!lead) return { ok: false, error: "Enquiry not found." };

  // Link the most recent sign-off if there is one — it anchors the evidence
  // pack (certificate, exceptions, the 7-day T&Cs window).
  const { data: completion } = await admin
    .from("job_completions")
    .select("id")
    .eq("lead_id", leadId)
    .order("signed_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: claim, error } = await admin
    .from("claims")
    .insert({
      lead_id: leadId,
      client_id: lead.client_id ?? null,
      completion_id: completion?.id ?? null,
      reported_channel: v.channel,
      description: v.description,
      opened_by: prof.id,
    } as never)
    .select("id, claim_no")
    .single();
  if (error || !claim) return { ok: false, error: "Could not open the claim — try again." };

  const ref = claimRef(claim.claim_no);
  await admin.from("activities").insert({
    lead_id: leadId,
    client_id: lead.client_id ?? null,
    actor_id: prof.id,
    type: "note",
    summary: `Claim ${ref} opened (${CLAIM_CHANNEL_LABEL[v.channel]}) — ${v.description.slice(0, 140)}`,
    meta: { claim_id: claim.id },
  });

  return { ok: true, claimId: claim.id, ref };
}

/* ------------------------------------------------------------ move it along */

const updateSchema = z.object({
  status: z.string().refine(isClaimStatus, { message: "Unknown claim status." }),
  resolution: z
    .string()
    .nullable()
    .refine((r): r is ClaimResolution | null => r === null || isClaimResolution(r), {
      message: "Unknown resolution.",
    }),
  resolutionAmount: z.number().finite().nullable(),
  insurerRef: z.string().trim().max(120).default(""),
  insurerNotified: z.boolean(),
  notes: z.string().max(8000).default(""),
});

export type ClaimUpdateInput = z.input<typeof updateSchema>;

export async function updateClaimAction(
  claimId: string,
  input: ClaimUpdateInput,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!uuid.safeParse(claimId).success) return { ok: false, error: "Invalid claim." };
  const prof = await requireOfficeProfile();
  if (!prof) return { ok: false, error: "Not signed in." };

  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the form and try again." };
  }
  const v = parsed.data;

  const check = validateClaimUpdate({
    status: v.status as ClaimStatus,
    resolution: (v.resolution ?? null) as ClaimResolution | null,
    resolutionAmount: v.resolutionAmount,
  });
  if (!check.ok) return { ok: false, error: check.error };

  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("claims")
    .select("id, lead_id, client_id, claim_no, status, closed_at, insurer_notified_at")
    .eq("id", claimId)
    .maybeSingle();
  if (!existing) return { ok: false, error: "Claim not found." };

  const nowIso = new Date().toISOString();
  const { error } = await admin
    .from("claims")
    .update({
      status: v.status,
      resolution: check.resolution,
      resolution_amount: check.resolutionAmount,
      insurer_ref: v.insurerRef,
      // first tick stamps the instant; unticking clears it (correction path)
      insurer_notified_at: v.insurerNotified ? (existing.insurer_notified_at ?? nowIso) : null,
      notes: v.notes,
      closed_at: check.terminal ? (existing.closed_at ?? nowIso) : null,
    } as never)
    .eq("id", claimId);
  if (error) return { ok: false, error: "Could not save the claim — try again." };

  if (existing.status !== v.status) {
    const ref = claimRef(existing.claim_no);
    const detail = check.terminal
      ? ` — ${CLAIM_RESOLUTION_LABEL[check.resolution as ClaimResolution]}${
          check.resolutionAmount != null ? ` £${check.resolutionAmount.toFixed(2)}` : ""
        }`
      : "";
    await admin.from("activities").insert({
      lead_id: existing.lead_id,
      client_id: existing.client_id ?? null,
      actor_id: prof.id,
      type: "note",
      summary: `Claim ${ref} → ${CLAIM_STATUS_LABEL[v.status as ClaimStatus]}${detail}`,
      meta: { claim_id: existing.id },
    });
  }

  return { ok: true };
}
