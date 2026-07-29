import { timingSafeEqual } from "crypto";

/**
 * SERVER ONLY — timing-safe compare for the crew sign-up link token.
 * Length-checked first (timingSafeEqual throws on unequal lengths); the only
 * thing a mismatch leaks is the length, which is fixed (24 random bytes,
 * base64url) and not secret.
 */
export function tokensMatch(candidate: string, expected: string): boolean {
  if (typeof candidate !== "string" || typeof expected !== "string") return false;
  if (!candidate || !expected) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
