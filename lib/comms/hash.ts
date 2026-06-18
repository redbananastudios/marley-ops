import { createHash } from "node:crypto";
import { normalizeEmail, normalizePhone } from "@/lib/leads/phone";

function norm(s?: string | null): string {
  return (s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

/** Normalise a recipient for matching: email lowercased, phone to E.164 (falls back to raw). */
export function normRecipient(channel: "email" | "sms", to: string): string {
  if (channel === "email") return normalizeEmail(to) ?? to.trim().toLowerCase();
  return normalizePhone(to) ?? to.trim();
}

/** Stable hash of a message's content — the duplicate-guard key. Cosmetic whitespace/case
 *  differences collapse; a different price/name/recipient produces a different hash. */
export function contentHash(input: {
  channel: "email" | "sms";
  toNorm: string;
  subject?: string | null;
  body: string;
  attachmentRef?: string | null;
}): string {
  return createHash("sha256")
    .update(
      [input.channel, input.toNorm, norm(input.subject), norm(input.body), input.attachmentRef ?? ""].join(
        "",
      ),
    )
    .digest("hex");
}
