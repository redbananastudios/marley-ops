import { createHash, randomBytes, timingSafeEqual } from "crypto";

/**
 * Crew portal invite tokens. A crew login is created without a usable password
 * (a random throwaway), then the crew member sets their own via a one-time
 * emailed link. The raw token is the bearer credential (same model as the /q,
 * /s and /join tokens); only its SHA-256 hash is stored, so the DB column is
 * useless if it ever leaks. Single-use + time-boxed.
 *
 * Pure + server-only (no DB here) so it is unit-testable.
 */

/** How long an emailed invite link stays valid. */
export const CREW_INVITE_TTL_DAYS = 7;

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time hash compare (both are fixed-length hex, so length isn't secret). */
export function inviteHashesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export interface MintedInvite {
  token: string; // goes in the email URL only
  tokenHash: string; // stored on profiles.invite_token_hash
  expiresAt: string; // ISO
}

export function mintCrewInvite(now = new Date()): MintedInvite {
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    tokenHash: hashInviteToken(token),
    expiresAt: new Date(now.getTime() + CREW_INVITE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString(),
  };
}

/** Has an invite (given its stored expiry) lapsed? */
export function isInviteExpired(expiresAt: string | null | undefined, now = new Date()): boolean {
  if (!expiresAt) return true;
  const t = new Date(expiresAt).getTime();
  return !Number.isFinite(t) || t <= now.getTime();
}

/** The public set-password URL the crew member opens. */
export function crewInviteUrl(token: string): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL || "https://ops.marleymoves.co.uk").replace(/\/$/, "");
  return `${base}/auth/set-password?token=${encodeURIComponent(token)}`;
}
