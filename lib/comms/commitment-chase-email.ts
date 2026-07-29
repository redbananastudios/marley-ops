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
 */

import { DATE_CONFIRM_ACKS } from "@/lib/signatures";
import { BANK_DETAILS } from "@/lib/comms/payment-email";
import { moveDateLabel } from "@/lib/quote/payments";

export const COMMITMENT_CHASE_TEMPLATE_ENV = "RESEND_TEMPLATE_COMMITMENT_CHASE";

/** The verbatim promise the customer signed at date confirmation. */
export const COMMITMENT_CHASE_WARNING = DATE_CONFIRM_ACKS[0].label;

const LOGO_URL = "https://quotes.marleymoves.co.uk/logo.png";

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
  const name = firstNameOf(m.firstName);
  const dueLabel = commitmentDueLabel(m.dueDate, m.todayUk);
  const moveLabel = moveDateLabel(m.movingDate) ?? "your booked date";

  const subject = `Your commitment payment is due ${dueLabel} (${m.quoteRef})`;

  const invoiceTextLine = m.invoiceUrl
    ? `\nYou can view your invoice${m.invoiceNumber ? ` (${m.invoiceNumber})` : ""} here:\n${m.invoiceUrl}\n`
    : "";

  const text = `Hi ${name},

Thank you for confirming your move date of ${moveLabel}. The next step in your booking is your commitment payment of ${gbp(m.amount)}, due ${dueLabel}. Your remaining balance is then due in full before move day.

You can pay by bank transfer, by card over the phone on 01747 637070, or in cash if that is easier:

Account name: ${BANK_DETAILS.name}
Sort code: ${BANK_DETAILS.sortCode}
Account number: ${BANK_DETAILS.account}
Reference: ${m.quoteRef}
${invoiceTextLine}
A quick reminder of what you agreed when you confirmed your date: "${COMMITMENT_CHASE_WARNING}"

If anything about your move has changed, or you would like to talk it through, reply to this email or call us on 01747 637070 and we will help.

Best regards,
The Marley Moves Accounts Team`;

  const invoiceButton = m.invoiceUrl
    ? `  <tr><td align="center" style="padding:0 36px 22px;">
    <table cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#C03838" style="border-radius:6px;">
      <a href="${m.invoiceUrl}" style="display:inline-block;padding:15px 38px;background:#C03838;color:#FFFFFF;font-size:14px;font-weight:600;text-decoration:none;border-radius:6px;letter-spacing:0.04em;">View your invoice &rarr;</a>
    </td></tr></table>
  </td></tr>`
    : "";

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

/* ---------------------------------------------------- fallback HTML shell
   Same visual language as payment-email.ts (logo on white, Georgia headline,
   red accent) — deliberately self-contained, like every fallback builder. */

function shell(preheader: string, inner: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Marley Moves</title></head>
<body style="margin:0;padding:0;background:#F6F5F3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1A1A1A;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;color:#F6F5F3;">${preheader}</div>
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F6F5F3;padding:32px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#FFFFFF;border-radius:8px;overflow:hidden;border:1px solid #E8E4DD;">
  <tr><td align="center" style="padding:34px 36px 8px;">
    <img src="${LOGO_URL}" alt="Marley Moves" width="180" style="display:block;margin:0 auto;max-width:60%;border:0;outline:none;text-decoration:none;">
  </td></tr>
${inner}
  <tr><td style="background:#FAFAFA;border-top:1px solid #EAE7E2;padding:20px 36px;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="font-size:11px;color:#6E6A65;line-height:1.7;">
        <div style="font-family:Georgia,'Times New Roman',serif;font-size:14px;font-weight:600;color:#1A1A1A;">Marley <span style="color:#C03838;">Moves</span></div>
        <div style="margin-top:2px;">Shaftesbury, SP7 · Company No. 15914266</div>
      </td>
      <td align="right" style="font-size:11px;color:#6E6A65;line-height:1.7;">
        <div><a href="tel:01747637070" style="color:#1A1A1A;text-decoration:none;font-weight:600;">01747 637070</a></div>
        <div><a href="https://marleymoves.co.uk" style="color:#6E6A65;text-decoration:none;">marleymoves.co.uk</a></div>
      </td>
    </tr></table>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function pill(label: string): string {
  return `  <tr><td align="center" style="padding:0 36px 24px;">
    <div style="display:inline-block;padding:6px 14px;background:#FFF3F1;border:1px solid #F5C9C4;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#C03838;">${label}</div>
  </td></tr>`;
}

function headline(text: string): string {
  return `  <tr><td align="center" style="padding:0 36px 6px;">
    <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:32px;font-weight:600;color:#1A1A1A;letter-spacing:-0.02em;line-height:1.18;margin:0;">${text}</h1>
  </td></tr>`;
}

function subline(html: string): string {
  return `  <tr><td align="center" style="padding:14px 36px 22px;">
    <p style="font-size:14px;color:#5A554F;line-height:1.65;margin:0 auto;max-width:440px;">${html}</p>
  </td></tr>`;
}

function bankCard(reference: string): string {
  const row = (l: string, v: string) => `<tr>
    <td style="padding:8px 0;border-bottom:1px solid #F0EDE8;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#8A857E;width:42%;">${l}</td>
    <td style="padding:8px 0;border-bottom:1px solid #F0EDE8;font-size:14px;color:#1A1A1A;font-weight:600;">${v}</td>
  </tr>`;
  return `  <tr><td style="padding:0 36px 22px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FAFAFA;border-radius:8px;overflow:hidden;">
      <tr><td style="padding:20px 24px;">
        <div style="font-size:10px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#6E6A65;margin-bottom:10px;">How to pay</div>
        <table width="100%" cellpadding="0" cellspacing="0">
          ${row("Account name", BANK_DETAILS.name)}
          ${row("Sort code", BANK_DETAILS.sortCode)}
          ${row("Account number", BANK_DETAILS.account)}
          <tr>
            <td style="padding:8px 0;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#8A857E;">Reference</td>
            <td style="padding:8px 0;font-size:14px;color:#C03838;font-weight:700;">${escapeHtml(reference)}</td>
          </tr>
        </table>
        <p style="margin:10px 0 0;font-size:12.5px;line-height:1.6;color:#6E6A65;">Bank transfer, card over the phone on 01747 637070, or cash. Whichever suits.</p>
      </td></tr>
    </table>
  </td></tr>`;
}

/** Branded fallback used when RESEND_TEMPLATE_COMMITMENT_CHASE isn't set. */
export function buildCommitmentChaseEmailHtml(m: CommitmentChaseMeta): string {
  const name = firstNameOf(m.firstName);
  const dueLabel = commitmentDueLabel(m.dueDate, m.todayUk);
  const moveLabel = moveDateLabel(m.movingDate) ?? "your booked date";

  const invoiceButton = m.invoiceUrl
    ? `  <tr><td align="center" style="padding:0 36px 22px;">
    <table cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#C03838" style="border-radius:6px;">
      <a href="${m.invoiceUrl}" style="display:inline-block;padding:15px 38px;background:#C03838;color:#FFFFFF;font-size:14px;font-weight:600;text-decoration:none;border-radius:6px;letter-spacing:0.04em;">View your invoice &rarr;</a>
    </td></tr></table>
  </td></tr>`
    : "";

  const inner = [
    pill(`Commitment payment · ${escapeHtml(m.quoteRef)}`),
    headline(`Your commitment payment${name !== "there" ? ", " + escapeHtml(name) : ""}`),
    subline(
      `Thank you for confirming your move date of <strong style="color:#1A1A1A;">${escapeHtml(moveLabel)}</strong>. The next step in your booking is your commitment payment, due <strong style="color:#1A1A1A;">${escapeHtml(dueLabel)}</strong>. Your remaining balance is then due in full before move day.`,
    ),
    `  <tr><td style="padding:0 36px 22px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border:1.5px solid #1A1A1A;border-radius:8px;overflow:hidden;">
      <tr><td style="padding:20px 26px;border-left:4px solid #C03838;">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.22em;color:#6E6A65;margin-bottom:6px;">Commitment due${
          m.invoiceNumber ? ` · Invoice ${escapeHtml(m.invoiceNumber)}` : ""
        }</div>
        <div style="font-family:Georgia,'Times New Roman',serif;font-size:36px;font-weight:700;color:#1A1A1A;letter-spacing:-0.02em;line-height:1;">${gbp(m.amount)}</div>
      </td></tr>
    </table>
  </td></tr>`,
    invoiceButton,
    bankCard(m.quoteRef),
    subline(
      `A quick reminder of what you agreed when you confirmed your date: &ldquo;${escapeHtml(COMMITMENT_CHASE_WARNING)}&rdquo;`,
    ),
    subline(
      `If anything about your move has changed, or you would like to talk it through, reply to this email or call us on <strong style="color:#C03838;">01747 637070</strong> and we will help.`,
    ),
  ].join("\n");

  return shell(
    `Your commitment payment of ${gbp(m.amount)} is due ${dueLabel}.`,
    inner,
  );
}
