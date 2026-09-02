"use server";

/**
 * Public cubic-survey submission (/cv/<token>) — the customer fills their own
 * inventory before the survey visit or a phone quote. Token is the credential
 * (unguessable, minted by the office). The page shows NO PII beyond the first
 * name, and this action touches ONLY the token's row.
 *
 * Review hardening (2026-07-10): writes go to `customer_notes` (never the
 * office's internal `notes`); the "office finalised it" guard is ATOMIC
 * (status predicate on the UPDATE, not just a pre-read); the ops alert +
 * activity fire on the first submission or a changed total — repeat identical
 * submits save quietly, so the token can't be used to spam the office.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { sendOpsAlert } from "@/lib/comms/dispatch";
import { errorContext, log } from "@/lib/log";
import { CUSTOMER_SURVEY_PHOTO_CATEGORY } from "@/lib/survey-photos";
import {
  computeCubicTotals,
  reconcileCubicLineProvenance,
  sanitizeCubicLines,
  type CubicLine,
} from "@/lib/cubic-survey";
import {
  customerPhotoStore,
  cvAdminClient,
  findSurveyRowId,
  resolveCvSurvey,
} from "./photo-store";

const TOKEN_RE = /^[\w-]{10,64}$/;

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export async function submitCubicCustomerAction(
  token: string,
  raw: { items: CubicLine[]; notes: string; status?: "draft" | "complete"; baseUpdatedAt?: string },
): Promise<{ ok: true; totalFt3: number; updatedAt: string } | { ok: false; error: string }> {
  if (!TOKEN_RE.test(token)) return { ok: false, error: "This link isn't valid." };

  const admin = createAdminClient();
  const { data: row } = await admin
    .from("cubic_surveys")
    .select("id, lead_id, client_id, status, total_ft3, items")
    .eq("share_token", token)
    .maybeSingle();
  // No number: there is no row, so there is no lead and no brand to resolve one
  // from — and a hardcoded number here is precisely how a customer of one brand
  // was handed another brand's office. Wording matches the sibling below.
  if (!row) return { ok: false, error: "This link isn't valid." };
  if (row.status === "complete") {
    return { ok: false, error: "This survey has already been finalised — call us if anything changed." };
  }

  const incomingLines = sanitizeCubicLines(raw.items);
  if (incomingLines === null || incomingLines.length === 0) return { ok: false, error: "Add at least one item first." };
  const trustedLines = sanitizeCubicLines(row.items);
  // Same rule as above — "call us" without naming a number, matching the
  // already-finalised message, so the page never quotes another brand's office.
  if (trustedLines === null) return { ok: false, error: "This survey needs attention — please call us." };
  const lines = reconcileCubicLineProvenance(incomingLines, trustedLines);
  const totals = computeCubicTotals(lines);
  const customerNotes = String(raw.notes ?? "").trim().slice(0, 4000);

  // Atomic guard: the write only lands while the office hasn't finalised —
  // a pre-read check alone would race "Mark complete" on the estimator's tablet.
  const { data: updated, error } = await admin
    .from("cubic_surveys")
    .update({
      items: lines as never,
      total_ft3: totals.totalFt3,
      customer_notes: customerNotes,
      status: "customer_submitted",
    } as never)
    .eq("id", row.id)
    .neq("status", "complete")
    .select("updated_at")
    .maybeSingle();
  if (error) return { ok: false, error: "Could not save — try again." };
  if (!updated) {
    return { ok: false, error: "This survey has already been finalised — call us if anything changed." };
  }

  // First submission (or a changed total) is office-worthy; identical
  // resubmits save quietly.
  const firstSubmit = row.status !== "customer_submitted";
  const totalChanged = Math.abs(Number(row.total_ft3) - totals.totalFt3) >= 0.1;
  if (row.lead_id && (firstSubmit || totalChanged)) {
    const { data: lead } = await admin.from("leads").select("name").eq("id", row.lead_id).maybeSingle();
    await admin.from("activities").insert({
      lead_id: row.lead_id,
      client_id: row.client_id,
      type: "note",
      summary: `Customer ${firstSubmit ? "completed" : "updated"} their cubic survey — ${totals.totalFt3} ft³ across ${totals.itemCount} items`,
      meta: { cubic_survey_id: row.id, via: "cubic_customer_link" },
    });
    // Email the desk on the FIRST submission only — repeated customer edits still
    // update the activity + the survey data, but must not fire an alert each time
    // (alert amplification). The office sees later changes on the Survey tab.
    if (firstSubmit) {
      await sendOpsAlert(`Customer cubic survey received`, [
        `<strong>${esc(lead?.name ?? "A customer")}</strong> filled in their volume survey: <strong>${totals.totalFt3} ft³</strong> across ${totals.itemCount} items.`,
        `Review it on the lead's Survey tab — it will suggest the van count on the next quote.`,
      ]);
    }
  }
  return { ok: true, totalFt3: totals.totalFt3, updatedAt: updated.updated_at };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Remove one photo the customer added through this link (QA-20260827-04's
 * counterpart to the upload route — a wrong photo must be removable, or the
 * only recourse is a phone call).
 *
 * `photoId` is the ONLY thing taken from the client, and it is not trusted: the
 * survey is re-resolved from the token and the delete is filtered to that
 * survey's own row set. `customer_uploaded` (migration 0117) and
 * `uploaded_by is null` each narrow it further to photos the CUSTOMER added, so
 * a share token can never delete evidence an estimator took inside the house —
 * and `customer_uploaded` is the one that holds even for a historic office row
 * that happens to carry a null uploader. A photo id that does not clear every
 * filter is simply "not found" — the reply says nothing about whether it exists
 * elsewhere.
 */
export async function deleteCubicCustomerPhotoAction(
  token: string,
  photoId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!UUID_RE.test(photoId)) return { ok: false, error: "That photo could not be found." };

  const admin = cvAdminClient();
  const resolved = await resolveCvSurvey(token, admin);
  if (!resolved.ok) return { ok: false, error: resolved.error };

  const surveyRow = await findSurveyRowId(admin, resolved.survey.leadId);
  if (!surveyRow.ok) return { ok: false, error: "We couldn't remove that just now. Please try again shortly." };
  if (!surveyRow.id) return { ok: false, error: "That photo could not be found." };

  const { data: photo, error: readError } = await admin
    .from("survey_photos")
    .select("id, storage_path")
    .eq("id", photoId)
    .eq("survey_id", surveyRow.id)
    .eq("category", CUSTOMER_SURVEY_PHOTO_CATEGORY)
    .eq("customer_uploaded", true)
    .is("uploaded_by", null)
    .maybeSingle();
  if (readError) return { ok: false, error: "We couldn't remove that just now. Please try again shortly." };
  if (!photo?.storage_path) return { ok: false, error: "That photo could not be found." };

  // Object first, row second, and KEEP the row if the object survives — the
  // same ordering (and reason) as the office deleteSurveyPhoto: a pointerless
  // object holding interior-of-home imagery is the worse of the two failures.
  try {
    await customerPhotoStore().deleteObjects([photo.storage_path]);
  } catch (error) {
    log.error("cv.photo.delete_object_failed", { photoId: photo.id, ...errorContext(error) });
    return { ok: false, error: "We couldn't remove that photo. Please try again shortly." };
  }
  const { error: deleteError } = await admin
    .from("survey_photos")
    .delete()
    .eq("id", photo.id)
    .eq("survey_id", surveyRow.id)
    .eq("customer_uploaded", true)
    .is("uploaded_by", null);
  if (deleteError) return { ok: false, error: "We couldn't remove that photo. Please try again shortly." };
  return { ok: true };
}
