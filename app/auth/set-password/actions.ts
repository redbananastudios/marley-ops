"use server";

/**
 * PUBLIC action — a crew member on /auth/set-password?token=… setting their own
 * password from the emailed invite. No session: the one-time invite token is the
 * credential (we match its SHA-256 hash, server-side). On success we set the
 * password via the admin API, burn the token (single use), and hand back a
 * magiclink hashed_token the client swaps for a session — the same handshake the
 * passkey sign-in uses.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { hashInviteToken, isInviteExpired } from "@/lib/staff/crew-invite";
import { errorContext, log } from "@/lib/log";

export type SetCrewPasswordResult =
  | { ok: true; tokenHash: string }
  | { ok: false; error: string }
  | { ok: true; passwordSet: true }; // password set, but auto sign-in unavailable → use the login page

const DEAD_LINK = "This link is no longer valid. Ask the office to send you a fresh one.";

export async function setCrewPasswordAction(token: string, password: string): Promise<SetCrewPasswordResult> {
  if (typeof password !== "string" || password.length < 8) {
    return { ok: false, error: "Choose a password of at least 8 characters." };
  }
  if (typeof token !== "string" || token.length < 20) {
    return { ok: false, error: DEAD_LINK };
  }

  const admin = createAdminClient();
  const { data } = await admin
    .from("profiles")
    .select("id, email, active, invite_expires_at")
    // .filter (not .eq) — the column isn't in the generated schema type yet.
    .filter("invite_token_hash", "eq", hashInviteToken(token))
    .maybeSingle();
  const profile = data as unknown as
    | { id: string; email: string | null; active: boolean; invite_expires_at: string | null }
    | null;

  if (!profile || !profile.active || isInviteExpired(profile.invite_expires_at)) {
    return { ok: false, error: DEAD_LINK };
  }

  const { error: pwError } = await admin.auth.admin.updateUserById(profile.id, { password });
  if (pwError) {
    log.error("crew_invite.set_password_failed", { userId: profile.id, ...errorContext(pwError) });
    return { ok: false, error: "Could not set your password — please try again." };
  }

  // Single-use: burn the token so the link can't be replayed.
  await admin
    .from("profiles")
    .update({ invite_token_hash: null, invite_expires_at: null } as never)
    .eq("id", profile.id);

  // Establish a session via the magiclink hashed-token handshake (GoTrue has no
  // "here is a verified user, give me a session" primitive).
  if (!profile.email) return { ok: true, passwordSet: true };
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: profile.email,
  });
  const tokenHash = link?.properties?.hashed_token;
  if (linkError || !tokenHash) {
    // The password IS set — they can just sign in on the login page.
    return { ok: true, passwordSet: true };
  }
  return { ok: true, tokenHash };
}
