import { z } from "zod";
import { normalizeEmail } from "@/lib/leads/phone";

/** Zod validator for an office-directed recipient email. Server is authoritative:
 *  the dialog validates loosely for UX, this decides. */
const emailSchema = z.string().email();

/**
 * Parse the optional "Send to" address an office user typed when sending or
 * re-sending a quote email. Empty/undefined → no override (send to the lead as
 * usual). A non-empty value is trimmed + lowercased (same normalisation the
 * duplicate-guard + client dedupe use) and validated; an invalid one is rejected
 * so the server never dispatches to a malformed address.
 */
export function parseAltRecipient(
  raw: string | null | undefined,
):
  | { ok: true; email: string | null }
  | { ok: false; error: string } {
  const norm = normalizeEmail(raw);
  if (norm === null) return { ok: true, email: null };
  if (!emailSchema.safeParse(norm).success) {
    return { ok: false, error: "Enter a valid email address." };
  }
  return { ok: true, email: norm };
}
