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
import {
  computeCubicTotals,
  reconcileCubicLineProvenance,
  sanitizeCubicLines,
  type CubicLine,
} from "@/lib/cubic-survey";

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
