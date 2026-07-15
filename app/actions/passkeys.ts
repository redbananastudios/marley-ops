"use server";

/**
 * Passkey (WebAuthn) quick sign-in actions (Peter, 2026-07-15). Two signed-in
 * flows (register a device, list/remove your devices) and two PUBLIC flows
 * (start + verify an assertion from the login screen). Assertions are verified
 * server-side; on success we mint a real Supabase session via the admin
 * generateLink → hashed_token → client verifyOtp handshake (GoTrue has no
 * "here's a verified user, give me a session" primitive, so the magiclink
 * hashed token is the bridge). Email + password remains the fallback path.
 */

import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionProfile } from "@/lib/auth";
import {
  buildAuthenticationOptions,
  buildRegistrationOptions,
  verifyAuthentication,
  verifyRegistration,
} from "@/lib/auth/passkeys";
import { RATE_LIMIT_WINDOW_MS, isRateLimited } from "@/lib/auth/passkey-helpers";
import { errorContext, log } from "@/lib/log";

export type PasskeySummary = {
  id: string;
  deviceLabel: string | null;
  createdAt: string;
  lastUsedAt: string | null;
};

// ── Registration (signed-in user adds this device) ──────────────────────────

/** Options for registering the current device as a passkey. Signed-in only. */
export async function startPasskeyRegistrationAction(): Promise<
  { ok: true; options: Awaited<ReturnType<typeof buildRegistrationOptions>> } | { ok: false; error: string }
> {
  const profile = await getSessionProfile();
  if (!profile) return { ok: false, error: "Please sign in first." };

  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("auth_passkeys")
    .select("credential_id, transports")
    .eq("user_id", profile.id);

  const options = await buildRegistrationOptions({
    userId: profile.id,
    userName: profile.email ?? profile.full_name,
    userDisplayName: profile.full_name,
    existing: (existing ?? []).map((r) => ({ credentialId: r.credential_id, transports: r.transports })),
  });
  return { ok: true, options };
}

/** Verify + store a new passkey for the signed-in user. */
export async function verifyPasskeyRegistrationAction(
  response: RegistrationResponseJSON,
  deviceLabel?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const profile = await getSessionProfile();
  if (!profile) return { ok: false, error: "Please sign in first." };

  const result = await verifyRegistration({ userId: profile.id, response });
  if (!result.ok) return result;

  const admin = createAdminClient();
  const label = (deviceLabel ?? "").trim().slice(0, 60) || null;
  const { error } = await admin.from("auth_passkeys").insert({
    user_id: profile.id,
    credential_id: result.credentialId,
    public_key: result.publicKey,
    counter: result.counter,
    transports: result.transports,
    device_label: label,
  });
  if (error) {
    // Unique violation = this credential is already registered (re-run) — treat
    // as success so the UI settles rather than showing a scary error.
    if (error.code === "23505") return { ok: true };
    log.error("passkey.register.insert_failed", { userId: profile.id, ...errorContext(error) });
    return { ok: false, error: "Could not save this device — try again." };
  }

  await admin.from("events_log").insert({
    actor_id: profile.id,
    entity_type: "passkey",
    entity_id: result.credentialId,
    action: "added",
    diff: { device_label: label } as never,
  });
  return { ok: true };
}

// ── Authentication (public — from the login screen) ─────────────────────────

/** Public: discoverable-credential options for a passkey sign-in. */
export async function startPasskeyAuthAction(): Promise<
  { ok: true; options: Awaited<ReturnType<typeof buildAuthenticationOptions>> } | { ok: false; error: string }
> {
  const options = await buildAuthenticationOptions();
  return { ok: true, options };
}

/**
 * Public: verify a passkey assertion and, on success, return a magiclink
 * hashed_token the client swaps for a session via supabase.auth.verifyOtp.
 * Rate-limited to MAX_FAILED_VERIFIES failed verifies per credential id per hour
 * (cheap append-only rows in auth_passkey_attempts). Rejects inactive profiles
 * BEFORE minting any session.
 */
export async function verifyPasskeyAuthAction(
  response: AuthenticationResponseJSON,
): Promise<{ ok: true; tokenHash: string; email: string } | { ok: false; error: string }> {
  const credentialId = typeof response?.id === "string" ? response.id : "";
  if (!credentialId) return { ok: false, error: "Invalid sign-in response." };

  const admin = createAdminClient();

  // Rate limit keyed on the CLAIMED credential id (bounds both credential-guessing
  // and hammering one real credential), checked before any crypto work.
  const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();
  const { count: failures } = await admin
    .from("auth_passkey_attempts")
    .select("id", { count: "exact", head: true })
    .eq("credential_id", credentialId)
    .gte("created_at", windowStart);
  if (isRateLimited(failures ?? 0)) {
    return { ok: false, error: "Too many attempts — wait a while, or sign in with your password." };
  }

  const recordFailure = async () => {
    await admin.from("auth_passkey_attempts").insert({ credential_id: credentialId });
  };

  const { data: cred } = await admin
    .from("auth_passkeys")
    .select("id, user_id, credential_id, public_key, counter, transports")
    .eq("credential_id", credentialId)
    .maybeSingle();
  if (!cred) {
    await recordFailure();
    return { ok: false, error: "That passkey isn't recognised. Sign in with your password and add it again." };
  }

  const result = await verifyAuthentication({
    response,
    credential: {
      credentialId: cred.credential_id,
      publicKey: cred.public_key,
      counter: cred.counter,
      transports: cred.transports,
    },
  });
  if (!result.ok) {
    await recordFailure();
    return result;
  }

  // Only sign in active team members — a suspended login must not be revivable
  // by a passkey the device still holds.
  const { data: profile } = await admin
    .from("profiles")
    .select("active")
    .eq("id", cred.user_id)
    .maybeSingle();
  if (!profile?.active) {
    return { ok: false, error: "This account isn't active. Contact the office." };
  }

  const { data: userRes } = await admin.auth.admin.getUserById(cred.user_id);
  const email = userRes.user?.email;
  if (!email) {
    log.error("passkey.auth.no_email", { userId: cred.user_id });
    return { ok: false, error: "Could not sign you in — use your password." };
  }

  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  const tokenHash = link?.properties?.hashed_token;
  if (linkError || !tokenHash) {
    log.error("passkey.auth.mint_failed", { userId: cred.user_id, ...errorContext(linkError) });
    return { ok: false, error: "Could not sign you in — use your password." };
  }

  // Advance the signature counter (replay defence) + stamp usage; reset the
  // failure log for this now-proven-good credential.
  await admin
    .from("auth_passkeys")
    .update({ counter: result.newCounter, last_used_at: new Date().toISOString() })
    .eq("id", cred.id);
  await admin.from("auth_passkey_attempts").delete().eq("credential_id", credentialId);

  return { ok: true, tokenHash, email };
}

// ── Device management (signed-in user) ──────────────────────────────────────

/** The current user's registered passkeys, newest first. */
export async function listPasskeysAction(): Promise<PasskeySummary[]> {
  const profile = await getSessionProfile();
  if (!profile) return [];
  const admin = createAdminClient();
  const { data } = await admin
    .from("auth_passkeys")
    .select("id, device_label, created_at, last_used_at")
    .eq("user_id", profile.id)
    .order("created_at", { ascending: false });
  return (data ?? []).map((r) => ({
    id: r.id,
    deviceLabel: r.device_label,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  }));
}

/** Remove one of the current user's passkeys (ownership enforced server-side). */
export async function deletePasskeyAction(id: string): Promise<{ ok: boolean }> {
  const profile = await getSessionProfile();
  if (!profile) return { ok: false };
  const admin = createAdminClient();
  const { data: row } = await admin
    .from("auth_passkeys")
    .select("id, user_id, credential_id")
    .eq("id", id)
    .maybeSingle();
  // Never delete a passkey that isn't yours, even with a guessed id.
  if (!row || row.user_id !== profile.id) return { ok: false };

  const { error } = await admin.from("auth_passkeys").delete().eq("id", id).eq("user_id", profile.id);
  if (error) return { ok: false };

  await admin.from("events_log").insert({
    actor_id: profile.id,
    entity_type: "passkey",
    entity_id: row.credential_id,
    action: "removed",
  });
  return { ok: true };
}
