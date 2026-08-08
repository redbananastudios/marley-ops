/**
 * Turn a survey notice's per-channel outcome into what the office is told.
 *
 * Why this is its own tested module: the outcome has FOUR states and the UI
 * used to collapse them into two. A duplicate-suppressed send was reported as
 * "sent", which is a lie with a real failure mode — the dedupe key is a content
 * hash with NO time window, so moving a survey Thu→Fri→Thu→Fri makes the third
 * email byte-identical to the first. It is silently dropped, the customer's
 * latest email still says Thursday, and the toast said the new time went out.
 *
 * Pure: no IO, no React.
 */

export type SendState = "sent" | "failed" | "skipped" | "duplicate";

export interface SurveySendOutcome {
  email: SendState;
  sms: SendState;
}

export interface SendReport {
  /** Channels that genuinely left, e.g. "email + SMS", else null. */
  sent: string | null;
  /** Channels that failed and need a human, else null. */
  failed: string | null;
  /** Channels suppressed as an exact duplicate of an earlier message. */
  duplicate: string | null;
}

const LABEL = { email: "email", sms: "SMS" } as const;

function join(outcome: SurveySendOutcome, state: SendState): string | null {
  const hit = (["email", "sms"] as const).filter((c) => outcome[c] === state).map((c) => LABEL[c]);
  return hit.length ? hit.join(" + ") : null;
}

export function reportSurveySend(outcome: SurveySendOutcome): SendReport {
  return {
    sent: join(outcome, "sent"),
    failed: join(outcome, "failed"),
    duplicate: join(outcome, "duplicate"),
  };
}

/**
 * The one-line warning for a duplicate-suppressed notice. Deliberately says
 * what to DO — the customer is still holding the older message, so somebody has
 * to reach them another way.
 */
export function duplicateWarning(channels: string, thing = "message"): string {
  return `The ${channels} ${thing} was identical to one already sent, so it was not sent again. The customer still has the earlier one — call them if the details changed.`;
}
