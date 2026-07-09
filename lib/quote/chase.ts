/**
 * Chase engine logic + the approved chase copy (Peter, 2026-07-09) — pure,
 * fully unit-tested. The cron route does the IO; everything decidable lives
 * here.
 *
 * Cadences:
 *  - QUOTED (quote sent, not accepted): emails on day 2 / 5 / 10 after the
 *    quote email, then a human call task. Auto-lapse to lost ("no_response")
 *    at 30 days — quote expiry.
 *  - PROVISIONAL (accepted online, deposit unpaid): emails on day 1 / 3 after
 *    acceptance, call task on day 5.
 *
 * Voice: personal plain-text from Connor — deliberately unbranded so it reads
 * typed, not blasted. UK English, no em-dashes.
 */

export const QUOTE_CHASE_DAYS = [2, 5, 10] as const;
export const DEPOSIT_CHASE_DAYS = [1, 3] as const;
export const DEPOSIT_CALL_DAY = 5;
export const QUOTE_LAPSE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The next due step (1-based) in a cadence, or null when nothing is due.
 * `completedSteps` is how many have already been sent; a step becomes due once
 * `now` reaches start + days[step-1]. Catches up one step per run (never
 * double-fires a backlog in a single day).
 */
export function dueChaseStep(
  startIso: string | null,
  completedSteps: number,
  days: readonly number[],
  now: Date = new Date(),
): number | null {
  if (!startIso) return null;
  const start = new Date(startIso).getTime();
  if (Number.isNaN(start)) return null;
  if (completedSteps >= days.length) return null;
  const nextIdx = completedSteps; // 0-based index of the next step
  return now.getTime() >= start + days[nextIdx] * DAY_MS ? nextIdx + 1 : null;
}

/** Quote lapse: 30 days after the quote email with no acceptance. */
export function isQuoteLapsed(sentIso: string | null, now: Date = new Date()): boolean {
  if (!sentIso) return false;
  const t = new Date(sentIso).getTime();
  return !Number.isNaN(t) && now.getTime() >= t + QUOTE_LAPSE_DAYS * DAY_MS;
}

/* ------------------------------------------------------------- loss reasons */

export const LOSS_REASONS = [
  { value: "too_expensive", label: "Too expensive" },
  { value: "chose_competitor", label: "Chose another company" },
  { value: "move_fell_through", label: "Move fell through" },
  { value: "dates_didnt_work", label: "Dates didn't work" },
  { value: "no_response", label: "No response" },
  { value: "other", label: "Other" },
] as const;

export type LossReason = (typeof LOSS_REASONS)[number]["value"];

export const lossReasonLabel = (value: string | null): string =>
  LOSS_REASONS.find((r) => r.value === value)?.label ?? "Not recorded";

/* ------------------------------------------------------------- chase copy */

export interface ChaseContext {
  firstName: string | null;
  quoteRef: string;
  acceptUrl: string;
  /** Quote expiry, pre-formatted for customers (e.g. "8 August"). */
  expiryLabel: string;
}

export interface ChaseEmail {
  subject: string;
  text: string;
  /** Resend template variables (the template mirrors `text`). */
  variables: Record<string, string>;
}

const first = (name: string | null): string => (name ?? "").trim().split(/\s+/)[0] || "there";

function vars(c: ChaseContext): Record<string, string> {
  return {
    CUSTOMER_FIRST_NAME: first(c.firstName),
    QUOTE_REF: c.quoteRef,
    ACCEPT_LINK: c.acceptUrl,
    EXPIRY_DATE: c.expiryLabel,
  };
}

export function quoteChaseEmail(step: 1 | 2 | 3, c: ChaseContext): ChaseEmail {
  const name = first(c.firstName);
  if (step === 1) {
    return {
      subject: `Did the quote come through okay, ${name}?`,
      text: `Hi ${name},

Connor here from Marley Moves. Just checking the quote for your move landed safely and seeing if you had any questions about it.

If you're happy with everything, you can accept it online in about 30 seconds and that reserves your date:
${c.acceptUrl}

Anything you'd like changing, just reply to this email or ring me on 01747 637070.

Thanks,
Connor
Marley Moves`,
      variables: vars(c),
    };
  }
  if (step === 2) {
    return {
      subject: "Shall I pencil your date in?",
      text: `Hi ${name},

Dates are starting to fill for the coming weeks (month-end and Fridays always go first), so I wanted to check where you're at with your quote.

Accepting online takes half a minute and the £100 deposit locks the crew and date in for you:
${c.acceptUrl}

If something in the quote doesn't look right, tell me and I'll sort it before anything is booked.

Thanks,
Connor`,
      variables: vars(c),
    };
  }
  return {
    subject: `Your quote is valid until ${c.expiryLabel}`,
    text: `Hi ${name},

A last note from me. Your quote ${c.quoteRef} stays valid until ${c.expiryLabel}, after that I'd need to re-check the price.

If you'd like the date held it's one click here:
${c.acceptUrl}

And if you've decided to go another way, no hard feelings at all. A one-line reply telling me what swung it would genuinely help us do better.

All the best with the move either way,
Connor
01747 637070`,
    variables: vars(c),
  };
}

export function depositChaseEmail(step: 1 | 2, c: ChaseContext): ChaseEmail {
  const name = first(c.firstName);
  if (step === 1) {
    return {
      subject: `Locking in your move date (${c.quoteRef})`,
      text: `Hi ${name},

Great to have you booked in. Your date is reserved, and the £100 deposit is what makes it firm on our side.

Everything you need is on your quote page, card or bank transfer:
${c.acceptUrl}

Bank transfer reference: ${c.quoteRef}

Thanks,
Connor`,
      variables: vars(c),
    };
  }
  return {
    subject: `Your date is still waiting (${c.quoteRef})`,
    text: `Hi ${name},

Just a nudge, we're holding your move date but I can't guarantee it much longer without the £100 deposit (${c.acceptUrl}).

If timing is tricky or plans have shifted, reply and tell me, I'd rather help than chase.

Thanks,
Connor`,
    variables: vars(c),
  };
}

/** Plain-look HTML fallback when a Resend template id isn't configured —
 *  keeps the personal typed feel (no branding, just readable text). */
export function chaseTextToHtml(text: string): string {
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const linked = esc.replace(
    /(https?:\/\/[^\s]+)/g,
    '<a href="$1" style="color:#1a56db;">$1</a>',
  );
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#1a1a1a;line-height:1.7;white-space:pre-wrap;">${linked}</div>`;
}

/** The per-lead reply address that routes an inbound reply back to its quote
 *  (Resend inbound on the reply subdomain → webhook → pause chase + log). */
export function replyAddressFor(acceptToken: string): string {
  const domain = process.env.REPLY_EMAIL_DOMAIN || "reply.marleymoves.co.uk";
  return `q-${acceptToken}@${domain}`;
}

/** Parse a reply address back to its accept token (null when not ours).
 *  The local part keeps its case — accept tokens are case-sensitive base64url. */
export function tokenFromReplyAddress(address: string): string | null {
  const m = /^\s*(?:.*<)?q-([A-Za-z0-9_-]{10,})@/i.exec(address);
  return m ? m[1] : null;
}

/** Customer-facing expiry label from the quote-email send date (30-day validity). */
export function expiryLabelFrom(sentIso: string | null, createdIso: string): string {
  const base = new Date(sentIso ?? createdIso);
  const expiry = new Date(base.getTime() + QUOTE_LAPSE_DAYS * DAY_MS);
  return expiry.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    timeZone: "Europe/London",
  });
}
