/**
 * Date-confirmation + commitment-received emails (Payments Policy v2 —
 * docs/payments-policy-v2-prd.md §5A/§5E). Same visual language as
 * payment-email.ts (logo on white, Georgia display headline, red accent).
 *
 *  - Date confirmation   → "Your date is locked in": deposit now held and
 *    non-refundable, the commitment invoice (25% of gross minus deposit) with
 *    its due date and bank details — or the zero-commitment variant when the
 *    deposit already covers it.
 *  - Commitment received → payment confirmation, balance-next framing.
 *
 * Copy rules (test-enforced in tests/lib/comms/date-confirm-email.test.ts):
 * the word "penalty" NEVER appears; all amounts are VAT-inclusive gross; UK
 * English; no em-dashes. Held-money framing is always "held against your
 * original date, refunded in full if we re-book it".
 *
 * Pure server utils — no React, no DOM, no IO.
 */

import { BANK_DETAILS, receiptDetailsBlock, receiptBlockVar, type ReceiptDetails } from "@/lib/comms/payment-email";

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

const firstNameOf = (name: string | null | undefined): string =>
  (name ?? "").trim().split(/\s+/)[0] || "there";

/* ------------------------------------------------------------ house shell */

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

function amountCard(label: string, amount: number, footnote?: string): string {
  return `  <tr><td style="padding:0 36px 22px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border:1.5px solid #1A1A1A;border-radius:8px;overflow:hidden;">
      <tr><td style="padding:20px 26px;border-left:4px solid #C03838;">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.22em;color:#6E6A65;margin-bottom:6px;">${label}</div>
        <div style="font-family:Georgia,'Times New Roman',serif;font-size:36px;font-weight:700;color:#1A1A1A;letter-spacing:-0.02em;line-height:1;">${gbp(amount)}</div>
        ${footnote ? `<div style="font-size:11px;color:#6E6A65;margin-top:6px;">${footnote}</div>` : ""}
      </td></tr>
    </table>
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

/* ------------------------------------------------------- date confirmation */

export interface DateConfirmationMeta {
  firstName?: string | null;
  quoteRef: string;
  /** Pre-formatted, e.g. "Monday 20 July" (moveDateLabel). */
  moveDateLabel?: string | null;
  /** The gross deposit already paid. */
  depositAmount: number;
  /** The commitment invoice amount (gross). 0 = the deposit covers it. */
  commitmentAmount: number;
  /** Pre-formatted due-date label ("Monday 13 July"), null = due now. */
  commitmentDueLabel?: string | null;
  invoiceNumber?: string | null;
  invoiceUrl?: string | null;
}

/** The held/non-refundable position, restated exactly as the customer agreed
 *  at signing. NEVER the word "penalty" — held-against-the-date framing only. */
const HELD_POSITION_LINE =
  "If you later cancel or move your date within 7 days of the move and we cannot re-book the day, amounts you have paid up to 25% of your job price are held against your original date, and are refunded in full if the day is re-booked.";

function dueClause(dueLabel: string | null | undefined): string {
  return dueLabel
    ? `due by <strong style="color:#1A1A1A;">${escapeHtml(dueLabel)}</strong>`
    : `due now`;
}

function dueClausePlain(dueLabel: string | null | undefined): string {
  return dueLabel ? `Due by ${escapeHtml(dueLabel)}` : `Due now`;
}

function commitmentBlockHtml(m: DateConfirmationMeta): string {
  if (m.commitmentAmount > 0) {
    return [
      amountCard(
        `Commitment payment${m.invoiceNumber ? ` · Invoice ${escapeHtml(m.invoiceNumber)}` : ""}`,
        m.commitmentAmount,
        `${dueClausePlain(m.commitmentDueLabel)} · counts towards your final bill`,
      ),
      m.invoiceUrl
        ? `  <tr><td align="center" style="padding:0 36px 22px;">
    <table cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#C03838" style="border-radius:6px;">
      <a href="${m.invoiceUrl}" style="display:inline-block;padding:15px 38px;background:#C03838;color:#FFFFFF;font-size:14px;font-weight:600;text-decoration:none;border-radius:6px;letter-spacing:0.04em;">View your invoice &rarr;</a>
    </td></tr></table>
  </td></tr>`
        : "",
      bankCard(m.quoteRef),
      subline(
        `Your commitment payment of <strong style="color:#1A1A1A;">${gbp(m.commitmentAmount)}</strong> is ${dueClause(m.commitmentDueLabel)}. It counts towards your final bill, and the remaining balance is due in full before move day.`,
      ),
    ]
      .filter(Boolean)
      .join("\n");
  }
  return subline(
    `Your deposit already covers the commitment for your booking, so there is nothing more to pay right now. Your remaining balance is due in full before move day and we will send the final invoice nearer the time.`,
  );
}

export function dateConfirmationTemplateVars(m: DateConfirmationMeta): Record<string, string> {
  return {
    CUSTOMER_FIRST_NAME: escapeHtml(firstNameOf(m.firstName)),
    QUOTE_REF: escapeHtml(m.quoteRef),
    MOVE_DATE_LABEL: escapeHtml(m.moveDateLabel ?? "your booked date"),
    DEPOSIT_AMOUNT: gbp(m.depositAmount),
    COMMITMENT_BLOCK: commitmentBlockHtml(m),
    HELD_POSITION_LINE,
  };
}

export function buildDateConfirmationEmailHtml(m: DateConfirmationMeta): string {
  const name = (m.firstName ?? "").trim().split(/\s+/)[0];
  const when = m.moveDateLabel
    ? ` on <strong style="color:#1A1A1A;">${escapeHtml(m.moveDateLabel)}</strong>`
    : "";
  const inner = [
    pill(`Move date confirmed · ${escapeHtml(m.quoteRef)}`),
    headline(`Your date is locked in${name ? ", " + escapeHtml(name) : ""}`),
    subline(
      `Thank you for confirming your move${when}. Your <strong style="color:#1A1A1A;">${gbp(m.depositAmount)}</strong> deposit is now held against your booking: from this point it is non-refundable and still counts towards your final bill.`,
    ),
    commitmentBlockHtml(m),
    subline(HELD_POSITION_LINE),
    subline(
      `Any questions, call Connor on <strong style="color:#C03838;">01747 637070</strong> or just reply to this email.`,
    ),
  ].join("\n");

  return shell(
    m.commitmentAmount > 0
      ? `Your move date is confirmed. Your ${gbp(m.commitmentAmount)} commitment payment is ${
          m.commitmentDueLabel ? `due by ${m.commitmentDueLabel}` : "due now"
        }.`
      : `Your move date is confirmed. Nothing more to pay right now.`,
    inner,
  );
}

/* ---------------------------------------------------- commitment received */

export interface CommitmentReceivedMeta {
  firstName?: string | null;
  quoteRef: string;
  /** Gross amount received. */
  amount: number;
  moveDateLabel?: string | null;
  receipt?: ReceiptDetails | null; // folds a formal receipt panel into the email
}

export function commitmentReceivedTemplateVars(m: CommitmentReceivedMeta): Record<string, string> {
  return {
    CUSTOMER_FIRST_NAME: escapeHtml(firstNameOf(m.firstName)),
    QUOTE_REF: escapeHtml(m.quoteRef),
    AMOUNT: gbp(m.amount),
    MOVE_DATE_LABEL: escapeHtml(m.moveDateLabel ?? "your booked date"),
    RECEIPT_BLOCK: receiptBlockVar(m.receipt),
  };
}

export function buildCommitmentReceivedEmailHtml(m: CommitmentReceivedMeta): string {
  const name = (m.firstName ?? "").trim().split(/\s+/)[0];
  const when = m.moveDateLabel
    ? ` for your move on <strong style="color:#1A1A1A;">${escapeHtml(m.moveDateLabel)}</strong>`
    : "";
  const inner = [
    pill(`Payment received · ${escapeHtml(m.quoteRef)}`),
    headline(`Commitment received${name ? ", " + escapeHtml(name) : ""}`),
    subline(
      `We have received your <strong style="color:#1A1A1A;">${gbp(m.amount)}</strong> commitment payment${when}. It counts towards your final bill.`,
    ),
    m.receipt ? receiptDetailsBlock(m.receipt) : amountCard("Commitment paid", m.amount),
    subline(
      `Your remaining balance is due in full before move day and we will send the final invoice nearer the time. Any questions, call Connor on <strong style="color:#C03838;">01747 637070</strong> or just reply to this email.`,
    ),
  ].join("\n");
  return shell(
    `Your ${gbp(m.amount)} commitment payment is received. It counts towards your final bill.`,
    inner,
  );
}
