/**
 * Commitment chase email (Payments Policy v2 — docs/payments-policy-v2-prd.md
 * §5B, template B). Sent ONCE at T-10 (move − 10 UK days) when the customer
 * has confirmed their move date but the 25%-minus-deposit commitment invoice
 * is still unpaid.
 *
 * Money mail: the cron sends it via dispatchComm with From = accountsFrom().
 * Prefers the published Resend template (env RESEND_TEMPLATE_COMMITMENT_CHASE,
 * registered in scripts/create-resend-templates.mjs); the builders here are
 * the in-repo fallback and the source the template mirrors.
 *
 * Copy rules carried here:
 *  - The inside-7-day change warning is the DATE_CONFIRM_ACK promise VERBATIM
 *    (imported, never re-typed — the ack string and this email can only ever
 *    change together). Held-against-your-date framing; the word "penalty"
 *    never appears anywhere.
 *  - Every amount shown is VAT-inclusive gross.
 *  - UK English; no em-dashes outside the quoted acknowledgment.
 *
 * Multi-brand (docs/multi-brand-prd.md §3.5): the meta takes an optional
 * `brand`; absent/marley renders today's exact bytes. Non-default brands
 * carry disclosure (a) inside the bank block via the shared theme.
 */

import { DATE_CONFIRM_ACKS } from "@/lib/signatures";
import { BANK_DETAILS } from "@/lib/comms/payment-email";
import { moveDateLabel } from "@/lib/quote/payments";
import type { Brand } from "@/lib/brand";
import {
  emailTheme,
  themedBankCard,
  themedButtonRow,
  themedEmailShell,
  themedPill,
} from "@/lib/comms/email-brand";

export const COMMITMENT_CHASE_TEMPLATE_ENV = "RESEND_TEMPLATE_COMMITMENT_CHASE";

/** The verbatim promise the customer signed at date confirmation. */
export const COMMITMENT_CHASE_WARNING = DATE_CONFIRM_ACKS[0].label;

const gbp = (n: number): string =>
  "£" +
  Number(n)
    .toFixed(2)
    .replace(/\.00$/, "")
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface CommitmentChaseMeta {
  firstName?: string | null;
  quoteRef: string;
  /** The frozen commitment invoice amount — VAT-inclusive gross. */
  amount: number;
  /** quotes.commitment_due_date (yyyy-mm-dd). */
  dueDate: string | null;
  /** quotes.moving_date (yyyy-mm-dd). */
  movingDate: string | null;
  /** Hosted Zoho invoice page + number, when the raise recorded them. */
  invoiceUrl?: string | null;
  invoiceNumber?: string | null;
  /** Today's UK calendar day (yyyy-mm-dd) — decides "today" vs "by <date>". */
  todayUk: string;
  /** Sending brand — absent/marley renders today's exact bytes. */
  brand?: Brand | null;
}

const firstNameOf = (name: string | null | undefined): string =>
  (name ?? "").trim().split(/\s+/)[0] || "there";

/** "today" when the due date has arrived (late collapse), else "by Monday 17 August". */
export function commitmentDueLabel(dueDate: string | null, todayUk: string): string {
  if (!dueDate || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || dueDate <= todayUk) return "today";
  return `by ${moveDateLabel(dueDate) ?? dueDate}`;
}

export interface ComposedCommitmentChaseEmail {
  subject: string;
  /** Plain-text body (dispatchComm always carries bodyText). */
  text: string;
  /** In-repo branded HTML fallback when the template env isn't set. */
  html: string;
  /** Resend template variables — the template mirrors the fallback exactly. */
  variables: Record<string, string>;
}

/** One composition point so the template path and the fallback can never drift. */
export function composeCommitmentChaseEmail(m: CommitmentChaseMeta): ComposedCommitmentChaseEmail {
  const t = emailTheme(m.brand);
  const name = firstNameOf(m.firstName);
  const dueLabel = commitmentDueLabel(m.dueDate, m.todayUk);
  const moveLabel = moveDateLabel(m.movingDate) ?? "your booked date";

  const subject = `Your commitment payment is due ${dueLabel} (${m.quoteRef})`;

  const invoiceTextLine = m.invoiceUrl
    ? `\nYou can view your invoice${m.invoiceNumber ? ` (${m.invoiceNumber})` : ""} here:\n${m.invoiceUrl}\n`
    : "";

  const payToTextLine = t.payToNoteText(m.quoteRef);
  const text = `Hi ${name},

Thank you for confirming your move date of ${moveLabel}. The next step in your booking is your commitment payment of ${gbp(m.amount)}, due ${dueLabel}. Your remaining balance is then due in full before move day.

${t.payMethodsText}

Account name: ${BANK_DETAILS.name}
Sort code: ${BANK_DETAILS.sortCode}
Account number: ${BANK_DETAILS.account}
Reference: ${m.quoteRef}
${payToTextLine ? `\n${payToTextLine}\n` : ""}${invoiceTextLine}
A quick reminder of what you agreed when you confirmed your date: "${COMMITMENT_CHASE_WARNING}"

If anything about your move has changed, or you would like to talk it through, reply to this email or ${t.callUsText} and we will help.

Best regards,
The ${t.name} Accounts Team`;

  const invoiceButton = m.invoiceUrl ? themedButtonRow(m.invoiceUrl, "View your invoice &rarr;", t) : "";

  const variables: Record<string, string> = {
    CUSTOMER_FIRST_NAME: name,
    QUOTE_REF: escapeHtml(m.quoteRef),
    AMOUNT: gbp(m.amount),
    DUE_LABEL: escapeHtml(dueLabel),
    MOVE_DATE_LABEL: escapeHtml(moveLabel),
    INVOICE_META: m.invoiceNumber ? ` · Invoice ${escapeHtml(m.invoiceNumber)}` : "",
    INVOICE_BUTTON: invoiceButton,
    DATE_CONFIRM_ACK: escapeHtml(COMMITMENT_CHASE_WARNING),
  };

  return { subject, text, html: buildCommitmentChaseEmailHtml(m), variables };
}

/* ---------------------------------------------------- fallback HTML
   Same visual language as payment-email.ts (logo on white, Georgia headline,
   red accent), rendered through the shared brand-aware fragments in
   lib/comms/email-brand.ts — the default theme is byte-identical to the old
   self-contained shell. */

function subline(html: string): string {
  return `  <tr><td align="center" style="padding:14px 36px 22px;">
    <p style="font-size:14px;color:#5A554F;line-height:1.65;margin:0 auto;max-width:440px;">${html}</p>
  </td></tr>`;
}

function headline(text: string): string {
  return `  <tr><td align="center" style="padding:0 36px 6px;">
    <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:32px;font-weight:600;color:#1A1A1A;letter-spacing:-0.02em;line-height:1.18;margin:0;">${text}</h1>
  </td></tr>`;
}

/** Branded fallback used when RESEND_TEMPLATE_COMMITMENT_CHASE isn't set. */
export function buildCommitmentChaseEmailHtml(m: CommitmentChaseMeta): string {
  const t = emailTheme(m.brand);
  const name = firstNameOf(m.firstName);
  const dueLabel = commitmentDueLabel(m.dueDate, m.todayUk);
  const moveLabel = moveDateLabel(m.movingDate) ?? "your booked date";

  const invoiceButton = m.invoiceUrl ? themedButtonRow(m.invoiceUrl, "View your invoice &rarr;", t) : "";

  const inner = [
    themedPill(`Commitment payment · ${escapeHtml(m.quoteRef)}`, t),
    headline(`Your commitment payment${name !== "there" ? ", " + escapeHtml(name) : ""}`),
    subline(
      `Thank you for confirming your move date of <strong style="color:#1A1A1A;">${escapeHtml(moveLabel)}</strong>. The next step in your booking is your commitment payment, due <strong style="color:#1A1A1A;">${escapeHtml(dueLabel)}</strong>. Your remaining balance is then due in full before move day.`,
    ),
    `  <tr><td style="padding:0 36px 22px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border:1.5px solid #1A1A1A;border-radius:8px;overflow:hidden;">
      <tr><td style="padding:20px 26px;border-left:4px solid ${t.accent};">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.22em;color:#6E6A65;margin-bottom:6px;">Commitment due${
          m.invoiceNumber ? ` · Invoice ${escapeHtml(m.invoiceNumber)}` : ""
        }</div>
        <div style="font-family:Georgia,'Times New Roman',serif;font-size:36px;font-weight:700;color:#1A1A1A;letter-spacing:-0.02em;line-height:1;">${gbp(m.amount)}</div>
      </td></tr>
    </table>
  </td></tr>`,
    invoiceButton,
    themedBankCard(m.quoteRef, t),
    subline(
      `A quick reminder of what you agreed when you confirmed your date: &ldquo;${escapeHtml(COMMITMENT_CHASE_WARNING)}&rdquo;`,
    ),
    subline(
      `If anything about your move has changed, or you would like to talk it through, reply to this email or ${t.callUsHtml} and we will help.`,
    ),
  ].join("\n");

  return themedEmailShell(
    `Your commitment payment of ${gbp(m.amount)} is due ${dueLabel}.`,
    inner,
    t,
  );
}
