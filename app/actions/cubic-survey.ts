"use server";

/**
 * Cubic survey actions (Peter, 2026-07-10). The estimator's tablet is the
 * primary surface; the customer /cv/<token> page reuses the same save shape
 * via its own public action (app/cv/[token]/actions.ts). Totals are ALWAYS
 * recomputed server-side from the sanitised lines — the client's running
 * total is display-only.
 *
 * Concurrency (review findings, 2026-07-10): office saves carry the
 * updated_at they loaded (baseUpdatedAt) and the update only lands when the
 * row still matches — a stale tab (or a save racing a customer submission)
 * gets a clear "reload" error instead of silently clobbering. Token minting
 * is guarded with `.is("share_token", null)` so a concurrent mint can never
 * invalidate a link that was already copied.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { randomBytes } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { computeCubicTotals, reconcileCubicLineProvenance, sanitizeCubicLines } from "@/lib/cubic-survey";

async function requireActiveProfile() {
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return null;
  const { data: prof } = await sb.from("profiles").select("id, active, full_name").eq("id", user.id).single();
  if (!prof?.active) return null;
  return prof;
}

const saveSchema = z.object({
  items: z.unknown(),
  notes: z.string().max(4000).default(""),
  status: z.enum(["draft", "complete"]).optional(),
  /** updated_at the client loaded — optimistic-concurrency token. */
  baseUpdatedAt: z.string().min(1),
});

export type CubicSavePayload = z.input<typeof saveSchema>;

export async function saveCubicSurveyAction(
  surveyId: string,
  raw: CubicSavePayload,
): Promise<
  | { ok: true; totalFt3: number; updatedAt: string }
  | { ok: false; error: string; conflict?: boolean }
> {
  if (!z.string().uuid().safeParse(surveyId).success) return { ok: false, error: "Invalid survey" };
  const prof = await requireActiveProfile();
  if (!prof) return { ok: false, error: "Not signed in." };
  const parsed = saveSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Something in the survey didn't come through — try again." };

  const incomingLines = sanitizeCubicLines(parsed.data.items);
  if (incomingLines === null) return { ok: false, error: "An item didn't come through cleanly — check the list and retry." };

  const admin = createAdminClient();
  const { data: row } = await admin
    .from("cubic_surveys")
    .select("id, lead_id, client_id, status, items")
    .eq("id", surveyId)
    .single();
  if (!row) return { ok: false, error: "Survey not found." };
  const trustedLines = sanitizeCubicLines(row.items);
  if (trustedLines === null) return { ok: false, error: "The saved survey needs attention before it can be updated." };
  const lines = reconcileCubicLineProvenance(incomingLines, trustedLines);
  const totals = computeCubicTotals(lines);

  const nextStatus = parsed.data.status ?? (row.status === "draft" ? "draft" : row.status);
  // The update lands only if nobody wrote since this tab loaded/last saved.
  const { data: updated, error } = await admin
    .from("cubic_surveys")
    .update({
      items: lines as never,
      total_ft3: totals.totalFt3,
      notes: parsed.data.notes.trim(),
      status: nextStatus,
      updated_by: prof.id,
    } as never)
    .eq("id", surveyId)
    .eq("updated_at", parsed.data.baseUpdatedAt)
    .select("updated_at")
    .maybeSingle();
  if (error) return { ok: false, error: "Could not save — try again." };
  if (!updated) {
    return {
      ok: false,
      conflict: true,
      error: "This survey changed elsewhere (another device, or the customer submitted). Reload to continue.",
    };
  }

  // Completing is the office-visible moment; drafts stay quiet.
  if (parsed.data.status === "complete" && row.status !== "complete" && row.lead_id) {
    await admin.from("activities").insert({
      lead_id: row.lead_id,
      client_id: row.client_id,
      actor_id: prof.id,
      type: "note",
      summary: `Cubic survey completed — ${totals.totalFt3} ft³ across ${totals.itemCount} items`,
      meta: { cubic_survey_id: surveyId, via: "cubic_survey" },
    });
  }
  if (row.lead_id) revalidatePath(`/leads/${row.lead_id}`);
  return { ok: true, totalFt3: totals.totalFt3, updatedAt: updated.updated_at };
}

/** Get-or-create the lead's survey. Returns its id (used by the quote-side
 *  "Open cubic survey" / copy-link entry points, which only know the lead). */
async function ensureSurveyForLead(
  admin: ReturnType<typeof createAdminClient>,
  leadId: string,
  profileId: string,
): Promise<string | null> {
  const { data: existing } = await admin.from("cubic_surveys").select("id").eq("lead_id", leadId).maybeSingle();
  if (existing) return existing.id;
  const { data: lead } = await admin.from("leads").select("client_id").eq("id", leadId).single();
  if (!lead) return null;
  const { data, error } = await admin
    .from("cubic_surveys")
    .insert({ lead_id: leadId, client_id: lead.client_id, created_by: profileId, updated_by: profileId } as never)
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") {
      const { data: again } = await admin.from("cubic_surveys").select("id").eq("lead_id", leadId).maybeSingle();
      return again?.id ?? null;
    }
    return null;
  }
  return data.id;
}

/** Mint the customer self-fill link for a LEAD's survey (creating the survey
 *  if needed) — the quote card offers this even before a survey exists. */
export async function getCubicShareLinkByLeadAction(
  leadId: string,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  if (!z.string().uuid().safeParse(leadId).success) return { ok: false, error: "Invalid lead" };
  const prof = await requireActiveProfile();
  if (!prof) return { ok: false, error: "Not signed in." };
  const admin = createAdminClient();
  const surveyId = await ensureSurveyForLead(admin, leadId, prof.id);
  if (!surveyId) return { ok: false, error: "Could not start the survey." };
  return getCubicShareLinkAction(surveyId);
}

/** Mint (or fetch) the customer self-fill link for a survey. */
export async function getCubicShareLinkAction(
  surveyId: string,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  if (!z.string().uuid().safeParse(surveyId).success) return { ok: false, error: "Invalid survey" };
  const prof = await requireActiveProfile();
  if (!prof) return { ok: false, error: "Not signed in." };

  const admin = createAdminClient();
  const { data: row } = await admin.from("cubic_surveys").select("id, share_token").eq("id", surveyId).single();
  if (!row) return { ok: false, error: "Survey not found." };

  let token = row.share_token;
  if (!token) {
    const fresh = randomBytes(18).toString("base64url");
    // Only claim the slot if still empty — a concurrent mint must never
    // replace (and thereby invalidate) a link someone already sent out.
    const { data: claimed, error } = await admin
      .from("cubic_surveys")
      .update({ share_token: fresh } as never)
      .eq("id", surveyId)
      .is("share_token", null)
      .select("share_token")
      .maybeSingle();
    if (error) return { ok: false, error: "Could not create the link." };
    if (claimed) {
      token = claimed.share_token;
    } else {
      const { data: again } = await admin.from("cubic_surveys").select("share_token").eq("id", surveyId).single();
      token = again?.share_token ?? null;
    }
  }
  if (!token) return { ok: false, error: "Could not create the link." };
  const base = process.env.NEXT_PUBLIC_APP_URL || "https://ops.marleymoves.co.uk";
  return { ok: true, url: `${base}/cv/${token}` };
}
