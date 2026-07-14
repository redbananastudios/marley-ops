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
 * Voice: personal plain-text from Peter with his Marley Moves signature. It
 * should read like a genuine follow-up, not a campaign. UK English, no em-dashes.
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
  /** The lead owner (estimator) the chase comes from, e.g. "Luke James". */
  ownerName?: string | null;
  /** Deposit, pre-formatted (e.g. "£100"). */
  depositAmount?: string | null;
}

export interface ChaseEmail {
  subject: string;
  text: string;
  /** Owner-aware sender for this email (see chaseFromFor). */
  from: string;
  /** Resend template variables (the template mirrors `text`). */
  variables: Record<string, string>;
}

/** Capitalise a name segment that arrives all-lower ("freddy") or all-upper
 *  ("FREDDY") -> "Freddy"; leave intentional mixed case (McDonald, O'Brien) alone. */
const cap = (seg: string): string => {
  const letters = seg.replace(/[^A-Za-z]/g, "");
  if (!letters) return seg;
  if (letters === letters.toLowerCase() || letters === letters.toUpperCase()) {
    return seg.charAt(0).toUpperCase() + seg.slice(1).toLowerCase();
  }
  return seg;
};

const first = (name: string | null): string => cap((name ?? "").trim().split(/\s+/)[0]) || "there";

/** Owner's first name for the personal chase voice; falls back to the team. */
const ownerFirst = (name: string | null | undefined): string =>
  cap((name ?? "").trim().split(/\s+/)[0]) || "The Marley Moves Team";

/** The chase sender: the lead owner at the monitored Marley mailbox when a real
 *  owner name is known, otherwise a generic Marley sender. Never the unmonitored
 *  peter@ box. */
function chaseFromFor(ownerName: string | null | undefined): string {
  const owner = (ownerName ?? "").trim().split(/\s+/)[0];
  return owner
    ? `${cap(owner)} at Marley Moves <hello@marleymoves.co.uk>`
    : "Marley Moves <hello@marleymoves.co.uk>";
}

function vars(c: ChaseContext): Record<string, string> {
  return {
    CUSTOMER_FIRST_NAME: first(c.firstName),
    OWNER_NAME: ownerFirst(c.ownerName),
    QUOTE_REF: c.quoteRef,
    ACCEPT_LINK: c.acceptUrl,
    EXPIRY_DATE: c.expiryLabel,
    DEPOSIT_AMOUNT: c.depositAmount ?? "£100",
  };
}

export function quoteChaseEmail(step: 1 | 2 | 3, c: ChaseContext): ChaseEmail {
  const name = first(c.firstName);
  const owner = ownerFirst(c.ownerName);
  const from = chaseFromFor(c.ownerName);
  if (step === 1) {
    return {
      subject: `Did my quote come through okay, ${name}?`,
      text: `Hi ${name},

It's ${owner} here. I wanted to make sure quote ${c.quoteRef} reached you and see if anything needs explaining or changing.

If you're happy with everything, you can accept it online here:
${c.acceptUrl}

It takes about 30 seconds and provisionally reserves your move date.

If you'd rather talk it through, reply to this email or call me on 01747 637070.

Best regards,
${owner}`,
      from,
      variables: vars(c),
    };
  }
  if (step === 2) {
    return {
      subject: "Would you like me to hold your move date?",
      text: `Hi ${name},

I'm checking in on quote ${c.quoteRef}. Dates are starting to fill for the coming weeks, with Fridays and month-end usually going first.

If you'd like to go ahead, accept online and pay the £100 deposit to confirm the crew and date:
${c.acceptUrl}

If you're still deciding, or anything in the quote needs changing, just reply and I'll help.

Best regards,
${owner}`,
      from,
      variables: vars(c),
    };
  }
  return {
    subject: `Your quote is valid until ${c.expiryLabel}`,
    text: `Hi ${name},

This is my last follow-up about quote ${c.quoteRef}. It stays valid until ${c.expiryLabel}; after that I'll need to re-check both the price and availability.

If you'd like to go ahead, you can accept it here:
${c.acceptUrl}

If you no longer need the quote, reply with "not going ahead" and I won't follow up again. If you've chosen someone else, a one-line note about what made the difference would genuinely help us improve.

All the best with the move either way,
${owner}`,
    from,
    variables: vars(c),
  };
}

export function depositChaseEmail(step: 1 | 2, c: ChaseContext): ChaseEmail {
  const name = first(c.firstName);
  const owner = ownerFirst(c.ownerName);
  const from = chaseFromFor(c.ownerName);
  if (step === 1) {
    return {
      subject: `One last step to secure your move date (${c.quoteRef})`,
      text: `Hi ${name},

It's ${owner} here. Thanks for accepting your quote. I've provisionally held your move date; the £100 deposit confirms the booking and allocates the crew.

You can pay by card or bank transfer from your quote page:
${c.acceptUrl}

Bank transfer reference: ${c.quoteRef}

Once payment arrives, we'll email confirmation that everything is booked in.

Best regards,
${owner}`,
      from,
      variables: vars(c),
    };
  }
  return {
    subject: `Your move date is still provisional (${c.quoteRef})`,
    text: `Hi ${name},

I'm still holding your move date provisionally. To confirm it, please pay the £100 deposit using your quote page:
${c.acceptUrl}

If your plans have changed or you need help with payment, reply and let me know. I'd rather help than keep chasing.

Best regards,
${owner}`,
    from,
    variables: vars(c),
  };
}

const PETER_SIGNATURE_HTML = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="360" style="width:100%;max-width:360px;border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;color:#1F1D1B;mso-line-height-rule:exactly;">
  <tr><td style="padding:0 0 3px;font-size:20px;line-height:24px;font-weight:700;color:#111111;">Peter Farrell</td></tr>
  <tr><td style="padding:0 0 12px;font-size:13px;line-height:18px;color:#3A3A3A;">Director <span style="color:#C03838;">|</span> Marley Moves</td></tr>
  <tr><td style="padding:0 0 12px;border-top:2px solid #C03838;font-size:0;line-height:0;">&nbsp;</td></tr>
  <tr><td style="padding:0;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
      <tr>
        <td width="24" valign="top" style="width:24px;padding:0 6px 9px 0;"><img src="https://img.icons8.com/ios-filled/50/c03838/phone.png" width="18" height="18" alt="Telephone" border="0" style="display:block;width:18px;height:18px;border:0;"></td>
        <td valign="top" style="padding:0 0 9px;font-size:12px;line-height:18px;color:#1F1D1B;"><a href="tel:01747637070" style="color:#1F1D1B;text-decoration:none;">01747 637070</a><span style="color:#C03838;"> | </span><a href="tel:07572382366" style="color:#1F1D1B;text-decoration:none;">07572 382 366</a></td>
      </tr>
      <tr>
        <td width="24" valign="top" style="width:24px;padding:0 6px 9px 0;"><img src="https://img.icons8.com/ios-filled/50/c03838/new-post.png" width="18" height="18" alt="Email" border="0" style="display:block;width:18px;height:18px;border:0;"></td>
        <td valign="top" style="padding:0 0 9px;font-size:12px;line-height:18px;color:#1F1D1B;"><a href="mailto:peter@marleymoves.co.uk" style="color:#1F1D1B;text-decoration:none;">peter@marleymoves.co.uk</a></td>
      </tr>
      <tr>
        <td width="24" valign="top" style="width:24px;padding:0 6px 9px 0;"><img src="https://img.icons8.com/ios-filled/50/c03838/globe--v1.png" width="18" height="18" alt="Website" border="0" style="display:block;width:18px;height:18px;border:0;"></td>
        <td valign="top" style="padding:0 0 9px;font-size:12px;line-height:18px;color:#1F1D1B;"><a href="https://www.marleymoves.co.uk" style="color:#1F1D1B;text-decoration:none;">www.marleymoves.co.uk</a></td>
      </tr>
      <tr>
        <td width="24" valign="top" style="width:24px;padding:0 6px 10px 0;"><img src="https://img.icons8.com/ios-filled/50/c03838/marker.png" width="18" height="18" alt="Address" border="0" style="display:block;width:18px;height:18px;border:0;"></td>
        <td valign="top" style="padding:0 0 10px;font-size:12px;line-height:18px;color:#1F1D1B;">Ash Cottage, Sherborne Causeway,<br>Shaftesbury, SP7 9PX</td>
      </tr>
      <tr>
        <td width="24" style="width:24px;padding:0 6px 0 0;font-size:0;line-height:0;">&nbsp;</td>
        <td style="padding:0 0 12px;border-bottom:1px solid #D9D9D9;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr>
            <td style="padding:0 8px 0 0;"><a href="https://www.facebook.com/marleymoves" style="display:block;text-decoration:none;"><img src="https://img.icons8.com/ios-filled/50/c03838/facebook-new.png" width="24" height="24" alt="Facebook" border="0" style="display:block;width:24px;height:24px;border:0;"></a></td>
            <td style="padding:0 8px 0 0;"><a href="https://www.instagram.com/marleymovesltd" style="display:block;text-decoration:none;"><img src="https://img.icons8.com/ios-filled/50/c03838/instagram-new.png" width="24" height="24" alt="Instagram" border="0" style="display:block;width:24px;height:24px;border:0;"></a></td>
            <td style="padding:0;"><a href="https://wa.me/441747637070" style="display:block;text-decoration:none;"><img src="https://img.icons8.com/ios-filled/50/c03838/whatsapp.png" width="24" height="24" alt="WhatsApp" border="0" style="display:block;width:24px;height:24px;border:0;"></a></td>
          </tr></table>
        </td>
      </tr>
    </table>
  </td></tr>
  <tr><td style="padding:12px 0 0;"><a href="https://www.marleymoves.co.uk" style="text-decoration:none;border:0;"><img src="https://marleymoves.co.uk/logo.png" width="235" alt="Marley Moves" border="0" style="display:block;width:235px;max-width:100%;height:auto;border:0;"></a></td></tr>
  <tr><td style="padding:12px 0 0;font-size:9px;line-height:13px;color:#6A6A6A;">This communication contains information which is confidential and may also be privileged. It is for the exclusive use of the intended recipient. If you are not the intended recipient, please note that any form of distribution, copying or use of this communication or the information contained therein is strictly prohibited and may be unlawful.</td></tr>
</table>`;

/** Personal HTML fallback when a Resend template id isn't configured. Mirrors
 * the Outlook signature used by Peter, while keeping the message itself typed. */
export function chaseTextToHtml(text: string): string {
  const body = text.replace(/\nPeter\s*$/, "").trim();
  const esc = body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const linked = esc.replace(
    /(https?:\/\/[^\s]+)/g,
    '<a href="$1" style="color:#C03838;text-decoration:underline;">$1</a>',
  );
  const paragraphs = linked
    .split(/\n{2,}/)
    .map((paragraph) => `<p style="margin:0 0 16px;">${paragraph.replace(/\n/g, "<br>")}</p>`)
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#FFFFFF;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;border-collapse:collapse;"><tr><td style="padding:0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1A1A1A;line-height:1.7;">${paragraphs}</td></tr><tr><td style="padding:8px 0 0;">${PETER_SIGNATURE_HTML}</td></tr></table></td></tr></table></body></html>`;
}

/** The per-lead reply address that routes an inbound reply back to its quote
 *  (Resend inbound on the reply subdomain → webhook → pause chase + log). */
export function replyAddressFor(acceptToken: string): string {
  const domain = process.env.REPLY_EMAIL_DOMAIN || "reply.marleymoves.co.uk";
  // Display name so mail clients show "Marley Moves" not the raw token. The
  // inbound webhook's tokenFromReplyAddress parses either form.
  return `Marley Moves <q-${acceptToken}@${domain}>`;
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
