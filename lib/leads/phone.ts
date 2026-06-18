import { parsePhoneNumberFromString } from "libphonenumber-js";

/** Normalise a UK phone to E.164 (+44…), or null if unparseable. Match key for dedupe. */
export function normalizePhone(input?: string | null): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const parsed = parsePhoneNumberFromString(trimmed, "GB");
  return parsed?.isValid() ? parsed.number : null;
}

/** Normalise an email (lowercase + trim), or null. Match key for dedupe. */
export function normalizeEmail(input?: string | null): string | null {
  if (!input) return null;
  const v = input.trim().toLowerCase();
  return v.length ? v : null;
}
