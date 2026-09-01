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

import { capName, helloFromFor, ownerFrom, sanitizeDisplayName } from "@/lib/comms/sender";
import { DEFAULT_BRAND, type Brand } from "@/lib/brand";
import { emailTheme, type EmailTheme } from "@/lib/comms/email-brand";
import { round2 } from "@/lib/quote/payments";
import {
  COMMITMENT_DUE_DAYS_BEFORE,
  COMMITMENT_FLAG_GRACE_HOURS,
  CONFIRM_CALL_DAYS_BEFORE,
} from "@/lib/payments-policy";
import { ukDayOf } from "@/lib/sales-report";

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
  /** The owner's own @marleymoves.co.uk address — becomes the From address so
   *  Luke's chases send as luke@, Connor's as connor@ (sender.ts ownerFrom;
   *  anything off-domain falls back to hello@). */
  ownerEmail?: string | null;
  /** Deposit, pre-formatted (e.g. "£100"). */
  depositAmount?: string | null;
  /** Sending brand (multi-brand PRD §3.5) — absent/marley composes today's
   *  exact copy, signature and From. A non-default brand chases in its own
   *  name and phone, from its own front door. */
  brand?: Brand | null;
}

/** "£100" / "£300" / "£187.50" — the deposit as customers should read it. */
export function depositLabel(amount: number | null | undefined): string {
  const n = Number(amount ?? 0);
  if (!(n > 0)) return "£100";
  return "£" + (Number.isInteger(n) ? String(n) : n.toFixed(2));
}

export interface ChaseEmail {
  subject: string;
  text: string;
  /** Owner-aware sender for this email (see chaseFromFor). */
  from: string;
  /** Resend template variables (the template mirrors `text`). */
  variables: Record<string, string>;
}

const cap = capName;

const first = (name: string | null): string => cap((name ?? "").trim().split(/\s+/)[0]) || "there";

/** Owner's first name for the personal chase voice; falls back to the team. */
const ownerFirst = (name: string | null | undefined, t: EmailTheme = emailTheme()): string =>
  cap((name ?? "").trim().split(/\s+/)[0]) || (t.isDefault ? "The Marley Moves Team" : `The ${t.name} Team`);

/** The chase sender: the lead owner from THEIR OWN mailbox when their login is
 *  on the company domain ("Luke at Marley Moves <luke@marleymoves.co.uk>"),
 *  else the owner display name at hello@, else the plain house identity.
 *  Every personal identity is a MARLEY identity, so a non-default brand's
 *  chase fronts its own hello_from instead — a Pitmans customer must never
 *  see a Marley From (PRD §3.5). */
function chaseFromFor(
  ownerName: string | null | undefined,
  ownerEmail?: string | null,
  brand?: Brand | null,
): string {
  if (brand && brand.slug !== DEFAULT_BRAND) return helloFromFor(brand);
  return ownerFrom(ownerName, ownerEmail);
}

function vars(c: ChaseContext): Record<string, string> {
  return {
    CUSTOMER_FIRST_NAME: first(c.firstName),
    OWNER_NAME: ownerFirst(c.ownerName, emailTheme(c.brand)),
    QUOTE_REF: c.quoteRef,
    ACCEPT_LINK: c.acceptUrl,
    EXPIRY_DATE: c.expiryLabel,
    DEPOSIT_AMOUNT: c.depositAmount ?? "£100",
  };
}

export function quoteChaseEmail(step: 1 | 2 | 3, c: ChaseContext): ChaseEmail {
  const t = emailTheme(c.brand);
  const dep = c.depositAmount ?? "£100";
  const name = first(c.firstName);
  const owner = ownerFirst(c.ownerName, t);
  const from = chaseFromFor(c.ownerName, c.ownerEmail, c.brand);
  if (step === 1) {
    return {
      subject: `Did my quote come through okay, ${name}?`,
      text: `Hi ${name},

It's ${owner} here. I wanted to make sure quote ${c.quoteRef} reached you and see if anything needs explaining or changing.

If you're happy with everything, you can accept it online here:
${c.acceptUrl}

It takes about 30 seconds and provisionally reserves your move date.

If you'd rather talk it through, reply to this email or call me on ${t.phone}.

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

If your completion date isn't confirmed yet, that's completely normal. Most of our customers only have theirs two or three weeks before the move. Accepting now simply adds you to our priority list, so when your date does land we're best placed to accommodate it.

If you'd like to go ahead, accept online and pay the ${dep} deposit to secure your place and your crew:
${c.acceptUrl}

If you're still deciding, or anything in the quote needs changing, just reply and I'll help.

Best regards,
${owner}`,
      from,
      variables: vars(c),
    };
  }
  // The final chase is deliberately the ONE email in the ladder with no money
  // in it. By this point we have written three times and heard nothing back, so
  // a third push on the deposit lands as pressure on someone who may simply
  // have moved on, and it reads badly when we have never actually spoken to
  // them (Peter, 2026-08-11: "if we are trying to make contact i dont think we
  // should be putting numbers on this email"). What earns a reply here is
  // warmth, brevity, and an easy way out. The expiry stays because it is
  // genuinely useful to them and it is the honest reason for writing; it is
  // framed as a fact, not a deadline.
  return {
    subject: `Still here if you need anything, ${name}`,
    text: `Hi ${name},

It's ${owner} here, and this is the last reminder I'll send you, so I'll keep it brief.

Your quote ${c.quoteRef} is open until ${c.expiryLabel} and there's nothing you need to do before then. If anything has changed, a different date, more or less to move, or something you'd like me to look at again, just reply to this email or call me on ${t.phone}. I'd be glad to help.

Your quote is here whenever you want it:
${c.acceptUrl}

And if you've made other arrangements, that's absolutely fine. Reply with "not going ahead" and I'll leave you in peace. If you have a moment, any feedback on your decision would genuinely help us improve.

All the best with the move,
${owner}`,
    from,
    variables: vars(c),
  };
}

export function depositChaseEmail(step: 1 | 2, c: ChaseContext): ChaseEmail {
  const t = emailTheme(c.brand);
  const dep = c.depositAmount ?? "£100";
  const name = first(c.firstName);
  const owner = ownerFirst(c.ownerName, t);
  const from = chaseFromFor(c.ownerName, c.ownerEmail, c.brand);
  // The deposit accepts card ON THE PAYMENT PAGE for card-enabled brands; a
  // bank-only brand's page shows bank details, so the copy matches it. The
  // marley branch is today's literal.
  const payLine = t.isDefault
    ? "You can pay by card or bank transfer from your quote page:"
    : "You can pay by bank transfer from your quote page:";
  if (step === 1) {
    return {
      subject: `One last step to secure your booking (${c.quoteRef})`,
      text: `Hi ${name},

It's ${owner} here. Great to have you booked in. The last step is your ${dep} deposit, which makes everything official. Once it's in, we'll confirm your moving date with you to lock it in. If you're still waiting on completion, no problem, your booking is held with a fully amendable date. Either way, your price and your crew are secured.

${payLine}
${c.acceptUrl}

Bank transfer reference: ${c.quoteRef}
${t.isDefault ? "" : `\n${t.name} is part of MarleyMoves Ltd, so your payment goes to the MARLEYMOVES LTD account shown on your quote page. Please use reference ${c.quoteRef} so we can match it to your booking.\n`}
Once payment arrives, we'll email confirmation that everything is booked in.

Best regards,
${owner}`,
      from,
      variables: vars(c),
    };
  }
  return {
    subject: `Your booking is still provisional (${c.quoteRef})`,
    text: `Hi ${name},

Just a friendly reminder that we're still holding your booking for you. Whenever you're ready, the ${dep} deposit confirms your place and your crew. And if your date isn't settled yet, no problem at all. It stays fully amendable:
${c.acceptUrl}

If your timing has changed or plans have shifted, just reply and let me know.

Best regards,
${owner}`,
    from,
    variables: vars(c),
  };
}

const TEAM_SIGNATURE_HTML = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="360" style="width:100%;max-width:360px;border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;color:#1F1D1B;mso-line-height-rule:exactly;">
  <tr><td style="padding:0 0 3px;font-size:20px;line-height:24px;font-weight:700;color:#111111;">The Marley Moves Team</td></tr>
  <tr><td style="padding:0 0 12px;font-size:13px;line-height:18px;color:#3A3A3A;">Removals <span style="color:#C03838;">|</span> Storage <span style="color:#C03838;">|</span> Marley Moves</td></tr>
  <tr><td style="padding:0 0 12px;border-top:2px solid #C03838;font-size:0;line-height:0;">&nbsp;</td></tr>
  <tr><td style="padding:0;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
      <tr>
        <td width="24" valign="top" style="width:24px;padding:0 6px 9px 0;"><img src="https://img.icons8.com/ios-filled/50/c03838/phone.png" width="18" height="18" alt="Telephone" border="0" style="display:block;width:18px;height:18px;border:0;"></td>
        <td valign="top" style="padding:0 0 9px;font-size:12px;line-height:18px;color:#1F1D1B;"><a href="tel:01747637070" style="color:#1F1D1B;text-decoration:none;">01747 637070</a></td>
      </tr>
      <tr>
        <td width="24" valign="top" style="width:24px;padding:0 6px 9px 0;"><img src="https://img.icons8.com/ios-filled/50/c03838/new-post.png" width="18" height="18" alt="Email" border="0" style="display:block;width:18px;height:18px;border:0;"></td>
        <td valign="top" style="padding:0 0 9px;font-size:12px;line-height:18px;color:#1F1D1B;"><a href="mailto:hello@marleymoves.co.uk" style="color:#1F1D1B;text-decoration:none;">hello@marleymoves.co.uk</a></td>
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

/** A non-default brand's plain signature block: name, contact row, group and
 *  legal lines. Deliberately modest — the Marley block above carries socials
 *  and a logo that other brands' rows don't hold yet (Phase 0 stubs). */
function brandSignatureHtml(t: EmailTheme): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="360" style="width:100%;max-width:360px;border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;color:#1F1D1B;mso-line-height-rule:exactly;">
  <tr><td style="padding:0 0 3px;font-size:20px;line-height:24px;font-weight:700;color:#111111;">The ${esc(t.name)} Team</td></tr>${
    t.groupLine
      ? `\n  <tr><td style="padding:0 0 12px;font-size:13px;line-height:18px;color:#3A3A3A;">${esc(t.groupLine)}</td></tr>`
      : ""
  }
  <tr><td style="padding:0 0 12px;border-top:2px solid ${t.accent};font-size:0;line-height:0;">&nbsp;</td></tr>
  <tr><td style="padding:0 0 9px;font-size:12px;line-height:18px;color:#1F1D1B;"><a href="${t.telHref}" style="color:#1F1D1B;text-decoration:none;">${esc(t.phone)}</a> &middot; <a href="mailto:${esc(t.helloAddress)}" style="color:#1F1D1B;text-decoration:none;">${esc(t.helloAddress)}</a></td></tr>
  <tr><td style="padding:0 0 9px;font-size:12px;line-height:18px;color:#1F1D1B;"><a href="${t.websiteUrl}" style="color:#1F1D1B;text-decoration:none;">${esc(t.websiteLabel)}</a></td></tr>
  <tr><td style="padding:12px 0 0;font-size:9px;line-height:13px;color:#6A6A6A;">${t.footerMetaHtml}</td></tr>
</table>`;
}

/** House HTML fallback when a Resend template id isn't configured. Team-signed
 * (never a hardcoded individual — the owner voice lives in the message text).
 * `brand` swaps the signature and link colour; absent/marley = today's bytes. */
export function chaseTextToHtml(text: string, brand?: Brand | null): string {
  const t = emailTheme(brand);
  const body = text.replace(/\nPeter\s*$/, "").trim();
  const esc = body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const linked = esc.replace(
    /(https?:\/\/[^\s]+)/g,
    `<a href="$1" style="color:${t.accent};text-decoration:underline;">$1</a>`,
  );
  const paragraphs = linked
    .split(/\n{2,}/)
    .map((paragraph) => `<p style="margin:0 0 16px;">${paragraph.replace(/\n/g, "<br>")}</p>`)
    .join("");
  const signature = t.isDefault ? TEAM_SIGNATURE_HTML : brandSignatureHtml(t);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#FFFFFF;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;border-collapse:collapse;"><tr><td style="padding:0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1A1A1A;line-height:1.7;">${paragraphs}</td></tr><tr><td style="padding:8px 0 0;">${signature}</td></tr></table></td></tr></table></body></html>`;
}

/** The per-lead reply address that routes an inbound reply back to its quote
 *  (Resend inbound on the reply subdomain → webhook → pause chase + log). */
export function replyAddressFor(acceptToken: string, displayName = "Marley Moves"): string {
  const domain = process.env.REPLY_EMAIL_DOMAIN || "reply.marleymoves.co.uk";
  // Display name so mail clients show the brand, not the raw token — the
  // ADDRESS stays on Marley's Resend-inbound reply domain for every brand
  // (it is machine-facing; a stub brand's reply_domain has no MX yet and a
  // dead Reply-To would silently break the panel thread). The inbound
  // webhook's tokenFromReplyAddress parses either form. The name arrives as
  // brands.name and gets sender.ts's display-slot hardening, so a hostile
  // value can never smuggle a bare address or a header break into the
  // Reply-To; when nothing survives, the bare relay address stands alone.
  const display = sanitizeDisplayName(displayName);
  return display ? `${display} <q-${acceptToken}@${domain}>` : `q-${acceptToken}@${domain}`;
}

/** Parse a reply address back to its accept token (null when not ours).
 *  The local part keeps its case — accept tokens are case-sensitive base64url. */
export function tokenFromReplyAddress(address: string): string | null {
  const m = /^\s*(?:.*<)?q-([A-Za-z0-9_-]{10,})@/i.exec(address);
  return m ? m[1] : null;
}

/* --------------------------------------------------- commitment ladder (v2)
 * Payments Policy v2 (docs/payments-policy-v2-prd.md §5B): once a customer has
 * confirmed their move date, a 25%-minus-deposit commitment invoice exists and
 * the chase cron counts DOWN to the move (fleet-reminder style), not up from a
 * send date:
 *
 *   T-10 (move − 10 UK days, commitment unpaid) → "chase": the commitment
 *        chase email + a call task. Once, stamped in commitment_chase_t10_at
 *        AFTER delivery. If the date is NOT yet confirmed at T-10, a
 *        "confirm the move date" call task fires instead of any email
 *        ("confirm_date_call") — same one-shot stamp.
 *   T-7  (move − 7 UK days, still unpaid) → "flag": stamp date_releasable_at.
 *        A discretion marker only — the "Dates at risk" dashboard card. NEVER
 *        an automatic release and never a customer email. The flag also waits
 *        until the chase is ≥ COMMITMENT_FLAG_GRACE_HOURS old (paused leads:
 *        until confirmation is that old), so it can never fire in the same
 *        breath as the customer's first reminder — a late booker gets a real
 *        chance to pay before the office alarm sounds.
 *
 * Day maths is UK wall-clock (a 23:30 UTC summer instant is already tomorrow
 * in the UK). Both thresholds are inclusive (<=) so a late confirmation or a
 * downed cron still catches up; past move days are the post-move sweep's job.
 *
 * chase_paused (customer replied / handed to a human) suppresses the
 * customer-chasing actions (chase email + call tasks). It deliberately does
 * NOT suppress the T-7 flag: the flag is internal money-risk visibility — a
 * paused conversation must not hide an at-risk date from the office.
 */

export type CommitmentAction = "chase" | "flag" | "confirm_date_call";

export interface CommitmentSweepInput {
  /** quotes.moving_date (yyyy-mm-dd). */
  movingDate: string | null;
  /** leads.date_confirmed_at — null means the ladder isn't armed yet. */
  dateConfirmedAt: string | null;
  /** The never-create-twice claim column: null | 'pending' | real Zoho id. */
  zohoCommitmentInvoiceId: string | null;
  /** Frozen at raise (25% × gross − deposit at that moment). */
  commitmentInvoiceAmount: number | null;
  commitmentPaidAt: string | null;
  /** One-shot marker for the CUSTOMER commitment reminder email. */
  commitmentChaseT10At: string | null;
  /** One-shot marker for the INTERNAL "confirm the move date" call task.
   *  Separate from commitmentChaseT10At: sharing one stamp meant whichever
   *  fired first silenced the other, and in practice the internal nudge always
   *  won — so a customer who confirmed their date and was invoiced 25% never
   *  got the reminder about it. */
  dateConfirmNudgeAt: string | null;
  dateReleasableAt: string | null;
  chasePaused: boolean;
}

/** Today's UK calendar day (yyyy-mm-dd; en-CA = ISO date format). */
const ukTodayDay = (now: Date): string =>
  now.toLocaleDateString("en-CA", { timeZone: "Europe/London" });

/** Whole UK-calendar days from today until `day` (negative = past).
 *  Date strings carry no wall-clock component, so UTC maths on them is DST-safe. */
function daysUntilUkDay(day: string, now: Date): number | null {
  const target = Date.parse(`${day}T00:00:00Z`);
  const today = Date.parse(`${ukTodayDay(now)}T00:00:00Z`);
  if (Number.isNaN(target) || Number.isNaN(today)) return null;
  return Math.round((target - today) / DAY_MS);
}

/**
 * Which commitment-ladder actions are due for one confirmed lead's accepted
 * quote right now. Pure — the cron route does the IO and stamps the columns
 * only after each send/insert succeeds. "chase" and "flag" can never fire in
 * the same run: the flag's grace window is anchored to the chase stamp, so a
 * late confirmation chases first and flags no sooner than 24h later.
 */
export function dueCommitmentActions(
  input: CommitmentSweepInput,
  now: Date = new Date(),
): CommitmentAction[] {
  const moveDay = ukDayOf(input.movingDate);
  if (!moveDay) return [];
  const days = daysUntilUkDay(moveDay, now);
  // Past (or unparseable) move days belong to the post-move sweep, and a
  // chase email after the move date reads as tone-deaf automation.
  if (days === null || days < 0) return [];

  // Date not confirmed → nothing is invoiced yet. At T-10 a human calls to get
  // the confirmation; no customer email either way. Its own one-shot stamp, so
  // raising it never consumes the customer commitment reminder's.
  if (!input.dateConfirmedAt) {
    return days <= CONFIRM_CALL_DAYS_BEFORE && !input.dateConfirmNudgeAt && !input.chasePaused
      ? ["confirm_date_call"]
      : [];
  }

  // Confirmed branch needs a genuinely raised, unpaid, non-zero commitment
  // invoice ('pending' is the in-flight claim marker, never a real id; the
  // zero-commitment edge raises no invoice, so there is nothing to chase).
  const invoiceRaised =
    !!input.zohoCommitmentInvoiceId && input.zohoCommitmentInvoiceId !== "pending";
  const amount = Number(input.commitmentInvoiceAmount ?? 0);
  if (!invoiceRaised || input.commitmentPaidAt || !(amount > 0)) return [];

  const actions: CommitmentAction[] = [];
  if (days <= CONFIRM_CALL_DAYS_BEFORE && !input.commitmentChaseT10At && !input.chasePaused) {
    actions.push("chase");
  }
  // The flag's grace anchor is the chase itself — the customer must have had
  // COMMITMENT_FLAG_GRACE_HOURS to act on their reminder before the office is
  // alarmed (Brydee Thomas MMR034: flagged 48 min after paying her deposit).
  // A PAUSED lead never gets the chase, so its anchor falls back to the date
  // confirmation — the flag arrives later but is never hidden (the documented
  // invariant). Un-paused with no stamp = the chase hasn't gone out yet (this
  // run sends it, or the send keeps failing and its own alarms fire) — the
  // grace clock starts when it lands.
  const anchorIso = input.commitmentChaseT10At ?? (input.chasePaused ? input.dateConfirmedAt : null);
  const anchorMs = anchorIso ? Date.parse(anchorIso) : NaN;
  const graceServed =
    Number.isFinite(anchorMs) && now.getTime() - anchorMs >= COMMITMENT_FLAG_GRACE_HOURS * 3_600_000;
  if (days <= COMMITMENT_DUE_DAYS_BEFORE && !input.dateReleasableAt && graceServed) {
    actions.push("flag");
  }
  return actions;
}

/* ------------------------------------------------- post-move outstanding */

export interface PostMoveMoney {
  /** VAT-inclusive agreed price (agreed_price ?? grand_total). */
  agreed: number;
  depositAmount: number | null;
  depositPaidAt: string | null;
  /** quotes.commitment_invoice_amount — frozen at raise. */
  commitmentInvoiceAmount: number | null;
  commitmentPaidAt: string | null;
  balancePaidAt: string | null;
}

/**
 * What is still owed after move day: agreed − (deposit if PAID) − (commitment
 * if PAID), zeroed outright by balance_paid_at (the office's "all settled"
 * stamp) and never negative. Only money that actually landed reduces the
 * figure — an unpaid deposit or unpaid commitment invoice is still owed, so a
 * paid-commitment settled job auto-completes while an unpaid one alarms with
 * the right amount (Payments Policy v2 fix — the old maths only knew the
 * deposit and over-alarmed every commitment-paid job).
 */
export function postMoveOutstanding(m: PostMoveMoney): number {
  if (m.balancePaidAt) return 0;
  const deposit = m.depositPaidAt ? Number(m.depositAmount ?? 0) : 0;
  const commitment = m.commitmentPaidAt ? Number(m.commitmentInvoiceAmount ?? 0) : 0;
  return round2(Math.max(0, (m.agreed || 0) - deposit - commitment));
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
