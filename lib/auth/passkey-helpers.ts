/**
 * Pure passkey helpers — no Supabase, no @simplewebauthn, no env. Kept separate
 * from lib/auth/passkeys.ts (which pulls in the WebAuthn library + admin client)
 * so the deterministic parts are cheap to unit-test in a plain Node vitest.
 */

/** How long a server-issued challenge is valid for (5 minutes). */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

/** Rate limit: max failed authentication verifies per credential id per window. */
export const MAX_FAILED_VERIFIES = 10;
export const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

/** ISO timestamp a challenge issued at `now` should expire. */
export function challengeExpiry(now: Date = new Date(), ttlMs: number = CHALLENGE_TTL_MS): string {
  return new Date(now.getTime() + ttlMs).toISOString();
}

/** True when a stored `expires_at` is at or before `now` (defensive re-check; the
 *  DB lookup already filters on expiry, this guards against clock/query drift). */
export function isChallengeExpired(expiresAt: string, now: Date = new Date()): boolean {
  const t = new Date(expiresAt).getTime();
  if (Number.isNaN(t)) return true;
  return t <= now.getTime();
}

/** True once a credential has hit the failed-verify ceiling in the window. */
export function isRateLimited(failuresInWindow: number): boolean {
  return failuresInWindow >= MAX_FAILED_VERIFIES;
}

/**
 * A human device name derived from the User-Agent, used as the default label for
 * a newly registered passkey ("iPad", "iPhone", "Android phone", "This computer").
 * Best-effort only — the user can rename it later; never trusted for security.
 */
export function deviceLabelFromUserAgent(ua: string | null | undefined): string {
  const s = (ua ?? "").toLowerCase();
  if (!s) return "This device";
  if (s.includes("ipad")) return "iPad";
  if (s.includes("iphone")) return "iPhone";
  // iPadOS 13+ reports as desktop Safari but exposes touch; catch the common case.
  if (s.includes("macintosh") && s.includes("mobile")) return "iPad";
  if (s.includes("android")) return s.includes("mobile") ? "Android phone" : "Android tablet";
  return "This computer";
}

/**
 * Derive the WebAuthn Relying Party config from an app URL. rpID MUST be the
 * registrable domain (host only, no port/scheme) and origin the full scheme+host
 * — deriving both from NEXT_PUBLIC_APP_URL keeps local dev (localhost / i9) and
 * production (ops.marleymoves.co.uk) working from one source.
 */
export function rpConfigFromUrl(appUrl: string | null | undefined): {
  rpID: string;
  origin: string;
  rpName: string;
} {
  const fallback = "https://ops.marleymoves.co.uk";
  let url: URL;
  try {
    url = new URL(appUrl || fallback);
  } catch {
    url = new URL(fallback);
  }
  return { rpID: url.hostname, origin: url.origin, rpName: "Marley Ops" };
}

/**
 * The WebAuthn challenge is echoed inside the signed clientDataJSON. Decoding it
 * server-side is how we correlate a verify to the exact challenge row we issued
 * (the flow is discoverable, so there's no allowCredentials to key on). Returns
 * the base64url challenge string, or null if the client data can't be parsed.
 * `clientDataJSONB64Url` is `response.response.clientDataJSON` from the browser.
 */
export function decodeClientDataChallenge(clientDataJSONB64Url: string): string | null {
  try {
    const json = Buffer.from(clientDataJSONB64Url, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as { challenge?: unknown };
    return typeof parsed.challenge === "string" ? parsed.challenge : null;
  } catch {
    return null;
  }
}
