/**
 * Classifying a Resend delivery-failure event.
 *
 * The stakes are asymmetric, so the default matters. Treating a HARD bounce as
 * soft means we keep emailing a dead address and the lead eventually lapses to a
 * false "lost — no response". Treating a SOFT bounce as hard is worse: a full
 * mailbox or a temporary defer would flag a perfectly good customer's address as
 * invalid and pause their chasing, losing a live job to a problem that would
 * have cleared itself in an hour.
 *
 * So: only classify as soft when the provider actually says it is transient, and
 * treat a complaint as its own thing (the address works fine — the person does
 * not want our mail, which is a stronger stop than a bounce).
 */

export type BounceKind = "hard" | "soft" | "complaint";

/** Resend/SES transient markers, lowercased and matched as substrings. */
const TRANSIENT_MARKERS = ["soft", "transient", "temporary", "deferred", "mailboxfull", "mailbox_full", "messagetoolarge"];

export function classifyBounce(eventType: string, bounceType?: string | null): BounceKind {
  if (eventType === "email.complained") return "complaint";
  const raw = (bounceType ?? "").toLowerCase().replace(/[\s-]/g, "");
  if (TRANSIENT_MARKERS.some((marker) => raw.includes(marker))) return "soft";
  return "hard";
}

/** Does this classification mean "stop trusting the address"? */
export function suppressesAddress(kind: BounceKind): boolean {
  return kind !== "soft";
}
