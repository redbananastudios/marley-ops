/**
 * WebAuthn (passkey) server wrappers — SERVER ONLY (uses the service-role admin
 * client; never import into a client component). Thin layer over
 * @simplewebauthn/server that owns challenge issue/consume + credential shape
 * conversion. Session minting, rate limiting and profile gating live in the
 * server actions (app/actions/passkeys.ts) that call these.
 *
 * Correlation model: the WebAuthn challenge is echoed inside the signed
 * clientDataJSON, so on verify we decode it and delete-return the matching
 * challenge row we issued (deleteReturning = single-use, race-safe). The auth
 * flow is discoverable (no allowCredentials), so this decoded-challenge lookup
 * is how a public verify finds its own challenge without a session or cookie.
 */

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
  type VerifiedAuthenticationResponse,
  type VerifiedRegistrationResponse,
} from "@simplewebauthn/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  challengeExpiry,
  decodeClientDataChallenge,
  isChallengeExpired,
  rpConfigFromUrl,
} from "@/lib/auth/passkey-helpers";

type ChallengeKind = "registration" | "authentication";

export type StoredCredential = {
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: string | null;
};

function rp() {
  return rpConfigFromUrl(process.env.NEXT_PUBLIC_APP_URL);
}

// The COSE public key is binary; store it base64url as text.
function keyToText(key: Uint8Array): string {
  return Buffer.from(key).toString("base64url");
}
function textToKey(text: string): Uint8Array<ArrayBuffer> {
  // Copy into a Uint8Array backed by a fresh (non-shared) ArrayBuffer so the type
  // matches @simplewebauthn's WebAuthnCredential.publicKey (Uint8Array<ArrayBuffer>).
  const buf = Buffer.from(text, "base64url");
  const out = new Uint8Array(buf.byteLength);
  out.set(buf);
  return out;
}

const KNOWN_TRANSPORTS = new Set(["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"]);
function parseTransports(text: string | null | undefined): AuthenticatorTransportFuture[] | undefined {
  if (!text) return undefined;
  const list = text
    .split(",")
    .map((t) => t.trim())
    .filter((t) => KNOWN_TRANSPORTS.has(t)) as AuthenticatorTransportFuture[];
  return list.length ? list : undefined;
}

type Admin = ReturnType<typeof createAdminClient>;

/** Persist a fresh challenge (5-min TTL) and opportunistically bin expired ones. */
async function storeChallenge(
  admin: Admin,
  userId: string | null,
  challenge: string,
  kind: ChallengeKind,
): Promise<void> {
  await admin.from("auth_passkey_challenges").delete().lt("expires_at", new Date().toISOString());
  await admin.from("auth_passkey_challenges").insert({
    user_id: userId,
    challenge,
    kind,
    expires_at: challengeExpiry(),
  });
}

/** Delete-return the matching challenge (single use), rejecting expired rows. */
async function consumeChallenge(
  admin: Admin,
  args: { challenge: string; kind: ChallengeKind; userId?: string },
): Promise<string | null> {
  let q = admin
    .from("auth_passkey_challenges")
    .delete()
    .eq("challenge", args.challenge)
    .eq("kind", args.kind);
  if (args.userId !== undefined) q = q.eq("user_id", args.userId);
  const { data } = await q.select("challenge, expires_at");
  const row = data?.[0];
  if (!row) return null;
  if (isChallengeExpired(row.expires_at)) return null;
  return row.challenge;
}

/** Registration options for a signed-in user (excludes their existing passkeys). */
export async function buildRegistrationOptions(opts: {
  userId: string;
  userName: string;
  userDisplayName: string;
  existing: { credentialId: string; transports: string | null }[];
}): Promise<Awaited<ReturnType<typeof generateRegistrationOptions>>> {
  const { rpID, rpName } = rp();
  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: opts.userName,
    userDisplayName: opts.userDisplayName,
    attestationType: "none",
    excludeCredentials: opts.existing.map((c) => ({
      id: c.credentialId,
      transports: parseTransports(c.transports),
    })),
    authenticatorSelection: {
      // Platform authenticator = Face ID / fingerprint / device PIN. Discoverable
      // (resident) so the login screen needs no email first, verified so a
      // biometric/PIN is always required.
      authenticatorAttachment: "platform",
      residentKey: "required",
      userVerification: "required",
    },
  });
  const admin = createAdminClient();
  await storeChallenge(admin, opts.userId, options.challenge, "registration");
  return options;
}

/** Verify a registration response against the user's stored challenge. */
export async function verifyRegistration(opts: {
  userId: string;
  response: RegistrationResponseJSON;
}): Promise<{ ok: false; error: string } | ({ ok: true } & StoredCredential)> {
  const challengeValue = decodeClientDataChallenge(opts.response.response.clientDataJSON);
  if (!challengeValue) return { ok: false, error: "Invalid registration response." };
  const admin = createAdminClient();
  const challenge = await consumeChallenge(admin, {
    challenge: challengeValue,
    kind: "registration",
    userId: opts.userId,
  });
  if (!challenge) return { ok: false, error: "Your setup attempt expired — try again." };

  const { rpID, origin } = rp();
  let verification: VerifiedRegistrationResponse;
  try {
    verification = await verifyRegistrationResponse({
      response: opts.response,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    });
  } catch {
    return { ok: false, error: "Could not verify this device — try again." };
  }
  if (!verification.verified || !verification.registrationInfo) {
    return { ok: false, error: "Could not verify this device — try again." };
  }
  const cred = verification.registrationInfo.credential;
  return {
    ok: true,
    credentialId: cred.id,
    publicKey: keyToText(cred.publicKey),
    counter: cred.counter,
    transports: cred.transports?.length ? cred.transports.join(",") : null,
  };
}

/** Authentication options — discoverable (empty allowCredentials), UV required. */
export async function buildAuthenticationOptions(): Promise<
  Awaited<ReturnType<typeof generateAuthenticationOptions>>
> {
  const { rpID } = rp();
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: "required",
    allowCredentials: [],
  });
  const admin = createAdminClient();
  await storeChallenge(admin, null, options.challenge, "authentication");
  return options;
}

/** Verify an authentication assertion against its challenge + stored credential. */
export async function verifyAuthentication(opts: {
  response: AuthenticationResponseJSON;
  credential: StoredCredential;
}): Promise<{ ok: false; error: string } | { ok: true; newCounter: number }> {
  const challengeValue = decodeClientDataChallenge(opts.response.response.clientDataJSON);
  if (!challengeValue) return { ok: false, error: "Invalid sign-in response." };
  const admin = createAdminClient();
  const challenge = await consumeChallenge(admin, {
    challenge: challengeValue,
    kind: "authentication",
  });
  if (!challenge) return { ok: false, error: "Your sign-in attempt expired — try again." };

  const { rpID, origin } = rp();
  let verification: VerifiedAuthenticationResponse;
  try {
    verification = await verifyAuthenticationResponse({
      response: opts.response,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
      credential: {
        id: opts.credential.credentialId,
        publicKey: textToKey(opts.credential.publicKey),
        counter: opts.credential.counter,
        transports: parseTransports(opts.credential.transports),
      },
    });
  } catch {
    return { ok: false, error: "That passkey could not be verified." };
  }
  if (!verification.verified) return { ok: false, error: "That passkey could not be verified." };
  return { ok: true, newCounter: verification.authenticationInfo.newCounter };
}
