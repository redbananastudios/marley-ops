"use server";

/**
 * Turn a Staff & Fleet member into a crew portal login, then (separately) invite
 * them to set their own password. Two deliberate steps so no crew member is ever
 * emailed by accident: activate creates the login silently; sending the invite is
 * the ONLY thing that contacts them.
 */

import { revalidatePath } from "next/cache";
import { randomBytes } from "crypto";
import { getSessionProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/comms/send";
import { escapeHtml } from "@/lib/comms/escape-html";
import { mintCrewInvite, crewInviteUrl } from "@/lib/staff/crew-invite";
import { errorContext, log } from "@/lib/log";

async function requireAdmin() {
  const profile = await getSessionProfile();
  if (!profile) return { profile: null, error: "Not signed in." as const };
  if (profile.role !== "admin") return { profile: null, error: "Only admins can manage crew logins." as const };
  return { profile, error: null };
}

const UUID = /^[0-9a-f-]{36}$/i;

export type CrewLoginResult = { ok: true } | { ok: false; error: string };

/**
 * Create (or link) the auth login + profile for a staff member and link
 * staff.profile_id so /my-jobs resolves their assignments. Sends NO email.
 */
export async function activateCrewLoginAction(staffId: string): Promise<CrewLoginResult> {
  const { error } = await requireAdmin();
  if (error) return { ok: false, error };
  if (typeof staffId !== "string" || !UUID.test(staffId)) return { ok: false, error: "Invalid staff id." };

  const admin = createAdminClient();
  const { data: staff } = await admin
    .from("staff")
    .select("id, full_name, email, profile_id")
    .eq("id", staffId)
    .maybeSingle();
  if (!staff) return { ok: false, error: "That staff member no longer exists." };
  if (staff.profile_id) return { ok: false, error: "This person already has a login." };
  const email = (staff.email ?? "").trim().toLowerCase();
  if (!email) return { ok: false, error: "Add an email to this staff member first." };

  let userId: string;
  const { data: existingProfile } = await admin.from("profiles").select("id").eq("email", email).maybeSingle();
  if (existingProfile) {
    // A login already exists for this email — link it, but never touch its role
    // or active flag (don't silently demote an admin/estimator to crew).
    userId = existingProfile.id;
  } else {
    const { data: created, error: cErr } = await admin.auth.admin.createUser({
      email,
      password: randomBytes(24).toString("base64url"), // throwaway — they set their own via the invite
      email_confirm: true,
      user_metadata: { full_name: staff.full_name },
    });
    if (cErr || !created?.user) {
      log.error("crew_login.create_user_failed", { staffId, ...errorContext(cErr) });
      return { ok: false, error: cErr?.message ?? "Could not create the login." };
    }
    userId = created.user.id;
    const { error: pErr } = await admin
      .from("profiles")
      .upsert({ id: userId, email, full_name: staff.full_name, role: "crew", active: true });
    if (pErr) return { ok: false, error: pErr.message };
  }

  const { error: linkErr } = await admin.from("staff").update({ profile_id: userId }).eq("id", staffId);
  if (linkErr) return { ok: false, error: linkErr.message };

  revalidatePath("/resources");
  return { ok: true };
}

/**
 * Send (or resend) the crew member a one-time link to set their own password.
 * Mints a fresh 7-day token (superseding any previous) and emails the managed
 * Resend template. Admin only, deliberate — the sole crew-facing contact.
 */
export async function sendCrewInviteAction(staffId: string): Promise<CrewLoginResult> {
  const { error } = await requireAdmin();
  if (error) return { ok: false, error };
  if (typeof staffId !== "string" || !UUID.test(staffId)) return { ok: false, error: "Invalid staff id." };

  const admin = createAdminClient();
  const { data: staff } = await admin
    .from("staff")
    .select("id, full_name, profile_id")
    .eq("id", staffId)
    .maybeSingle();
  if (!staff?.profile_id) return { ok: false, error: "Activate this person's login first." };

  const { data: profile } = await admin
    .from("profiles")
    .select("id, email, active")
    .eq("id", staff.profile_id)
    .maybeSingle();
  if (!profile?.email) return { ok: false, error: "This login has no email." };
  if (!profile.active) return { ok: false, error: "This login is deactivated — reactivate it first." };

  const invite = mintCrewInvite();
  const { error: upErr } = await admin
    .from("profiles")
    .update({
      invite_token_hash: invite.tokenHash,
      invite_expires_at: invite.expiresAt,
      invite_sent_at: new Date().toISOString(),
    } as never)
    .eq("id", profile.id);
  if (upErr) return { ok: false, error: upErr.message };

  const firstName = (staff.full_name || "").split(/\s+/)[0] || "there";
  const url = crewInviteUrl(invite.token);
  const templateId = process.env.RESEND_TEMPLATE_CREW_INVITE;
  // Fresh token each send, so never dedupe across sends — scope the idempotency
  // key to THIS token so only a true double-submit is collapsed.
  const idempotencyKey = `marley-crew-invite/${profile.id}/${invite.tokenHash.slice(0, 16)}`;

  const result = templateId
    ? await sendEmail({
        to: profile.email,
        subject: "Set up your Marley Moves crew login",
        from: "Marley Moves <hello@marleymoves.co.uk>",
        template: { id: templateId, variables: { CREW_FIRST_NAME: firstName, SET_PASSWORD_URL: url } },
        idempotencyKey,
      })
    : await sendEmail({
        // Inline fallback until the Resend template env var is wired.
        to: profile.email,
        subject: "Set up your Marley Moves crew login",
        from: "Marley Moves <hello@marleymoves.co.uk>",
        html: `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;color:#1a1a1a;line-height:1.7;">
          <p>Hi ${escapeHtml(firstName)},</p>
          <p>Set your password to access your Marley Moves crew portal:</p>
          <p><a href="${url}" style="display:inline-block;padding:12px 22px;background:#C03838;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;">Set your password</a></p>
          <p style="font-size:12px;color:#71717a;">This link expires in 7 days. If it wasn't you, ignore this email.</p>
        </div>`,
        idempotencyKey,
      });

  if (!result.ok) {
    log.error("crew_invite.send_failed", { staffId, error: result.error });
    return { ok: false, error: result.error ?? "Could not send the invite email." };
  }

  revalidatePath("/resources");
  return { ok: true };
}
