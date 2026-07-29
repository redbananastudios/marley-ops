"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { sendOpsAlert } from "@/lib/comms/dispatch";
import { escapeHtml } from "@/lib/comms/escape-html";
import { tokensMatch } from "@/lib/staff/onboard-token";
import { normalisePhone, staffSubmissionSchema, type StaffSubmissionInput } from "@/lib/staff/onboarding";

/**
 * PUBLIC action — a crew applicant at /join/<token>. No session: the shared
 * unguessable token (24 random bytes, base64url) is the credential, re-verified
 * here server-side with a timing-safe compare. Writes go through the
 * service-role client ONLY (staff_submissions deliberately has no insert
 * policy, so anon/authed roles can't post directly to the table).
 */

// Same wording whether the token is wrong or the switch is off — the page must
// not hint which one failed.
const DEAD_LINK_ERROR = "This link is not active. Check with the office for a fresh one.";

/** Mint cap — mirrors the card pay-link mint cap idea: a leaked link can't
 *  flood the review queue (or the ops-alert inbox) faster than this. */
const SUBMISSIONS_PER_HOUR_CAP = 25;

export type JoinSubmitResult = { ok: true } | { ok: false; error: string };

export async function submitStaffOnboardingAction(
  token: string,
  input: StaffSubmissionInput & { company?: string },
): Promise<JoinSubmitResult> {
  const sb = createAdminClient();

  const { data: settings } = await sb
    .from("business_settings")
    .select("staff_onboard_enabled, staff_onboard_token")
    .eq("id", true)
    .maybeSingle();
  if (
    !settings?.staff_onboard_enabled ||
    !settings.staff_onboard_token ||
    typeof token !== "string" ||
    !tokensMatch(token, settings.staff_onboard_token)
  ) {
    return { ok: false, error: DEAD_LINK_ERROR };
  }

  // Honeypot: the "company" field is hidden from humans. A bot that filled it
  // gets a success-shaped response and we write nothing.
  if (typeof input?.company === "string" && input.company.trim() !== "") {
    return { ok: true };
  }

  const parsed = staffSubmissionSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the form and try again." };
  }
  const v = parsed.data;

  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count, error: countError } = await sb
    .from("staff_submissions")
    .select("id", { count: "exact", head: true })
    .gte("created_at", hourAgo);
  if (countError) {
    return { ok: false, error: "Something went wrong saving your details. Please try again." };
  }
  if ((count ?? 0) >= SUBMISSIONS_PER_HOUR_CAP) {
    return { ok: false, error: "We are getting a lot of sign-ups right now. Please try again later." };
  }

  const row = {
    full_name: v.full_name,
    date_of_birth: v.date_of_birth,
    address: v.address,
    email: v.email,
    phone: v.phone,
    is_driver: v.is_driver,
    emergency_contact_name: v.emergency_contact_name || null,
    emergency_contact_phone: v.emergency_contact_phone || null,
    notes: v.notes || null,
  };

  // Re-submission with the same email corrects earlier typos: update the
  // PENDING row instead of stacking a duplicate in the review queue. Emails are
  // normalised to lowercase by the schema, so eq() IS the lower(email) match.
  // Guard (review 2026-07-29): the update path also requires the SAME phone —
  // a shared-link holder posting someone else's email can't silently replace
  // that person's pending details; a mismatched phone lands as a second pending
  // row so the office sees both versions side by side.
  const { data: existingRow } = await sb
    .from("staff_submissions")
    .select("id, phone")
    .eq("status", "pending")
    .eq("email", v.email)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const existing =
    existingRow && normalisePhone(existingRow.phone) === normalisePhone(v.phone) ? existingRow : null;

  if (existing) {
    const { error } = await sb.from("staff_submissions").update(row).eq("id", existing.id).eq("status", "pending");
    if (error) return { ok: false, error: "Something went wrong saving your details. Please try again." };
  } else {
    const { error } = await sb.from("staff_submissions").insert(row);
    if (error) return { ok: false, error: "Something went wrong saving your details. Please try again." };
  }

  // Tell the office — best-effort: a mail failure never fails the submission
  // (sendOpsAlert already swallows internally; the guard covers a throw before it).
  try {
    await sendOpsAlert("New crew sign-up to review", [
      `${escapeHtml(v.full_name)} has submitted their details through the crew sign-up link.`,
      existing ? "This updates their earlier submission (same email)." : "It is waiting in the review queue.",
      "Review and approve it in Staff &amp; Fleet.",
    ]);
  } catch {
    // Submission already saved — the review queue in Staff & Fleet still shows it.
  }

  return { ok: true };
}
