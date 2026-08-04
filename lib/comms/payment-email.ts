/**
 * Branded payment emails — same visual language as quote-email.ts (logo on
 * white, Georgia display headline, red accent, charcoal ink).
 *
 *  - Deposit received  → "You're booked in" confirmation.
 *  - Balance invoice   → "Your final balance" request (pre-move, payment in
 *    full before the job), with BACS details + the hosted Zoho invoice link.
 *
 * Pure server utils — no React, no DOM. UK English, no em-dashes.
 */

const LOGO_URL = "https://quotes.marleymoves.co.uk/logo.png";

export const BANK_DETAILS = {
  name: "MARLEYMOVES LTD",
  sortCode: "04-00-03",
  account: "12787423",
} as const;

const gbp = (n: number): string =>
  "£" +
  Number(n)
    .toFixed(2)
    .replace(/\.00$/, "")
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

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

/* ---------------------------------------------------------- payment receipt
   A formal receipt panel folded into every "payment received" email so each one
   doubles as the customer's receipt (Peter, 2026-08-04). Shared by the deposit,
   balance (this file) and commitment (date-confirm-email.ts) confirmations. */

export type PaymentMethod = "card" | "bank_transfer" | "cash";

export interface ReceiptDetails {
  /** Receipt number — the Zoho document reference (e.g. "MMR019-DEP"). */
  receiptNumber: string;
  /** Pre-formatted UK date the payment landed, e.g. "4 August 2026". */
  paidAtLabel: string;
  method: PaymentMethod;
  /** Last 4 of the card, when method === "card" (nice-to-have). */
  cardLast4?: string | null;
  /** What the payment was for, e.g. "Booking deposit". */
  forLabel: string;
  /** Amount received (gross). */
  amount: number;
}

/** UK date a customer sees on a receipt, e.g. "4 August 2026". */
export const ukReceiptDate = (d: Date = new Date()): string =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(d);

/** Human payment-method label for a receipt. */
export function paymentMethodLabel(method: PaymentMethod, cardLast4?: string | null): string {
  if (method === "card") return cardLast4 ? `Card ending ${cardLast4}` : "Card";
  if (method === "cash") return "Cash";
  return "Bank transfer";
}

/**
 * The receipt panel: receipt number, date paid, method, what it was for, and the
 * amount received — house style (bordered card, red left accent, Georgia amount).
 * Pure; every interpolated value is HTML-escaped. Used as both the in-repo block
 * and the `{{RECEIPT_BLOCK}}` template variable so the two stay in step.
 */
export function receiptDetailsBlock(r: ReceiptDetails): string {
  const line = (label: string, value: string) => `<tr>
            <td style="padding:9px 0;border-bottom:1px solid #F0EDE8;font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#8A857E;width:44%;">${label}</td>
            <td style="padding:9px 0;border-bottom:1px solid #F0EDE8;font-size:14px;color:#1A1A1A;font-weight:600;text-align:right;">${value}</td>
          </tr>`;
  return `  <tr><td style="padding:0 36px 24px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border:1.5px solid #1A1A1A;border-radius:8px;overflow:hidden;">
      <tr><td style="padding:20px 26px;border-left:4px solid #C03838;">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.22em;color:#6E6A65;margin-bottom:12px;">Receipt</div>
        <table width="100%" cellpadding="0" cellspacing="0">
          ${line("Receipt no.", escapeHtml(r.receiptNumber))}
          ${line("Date paid", escapeHtml(r.paidAtLabel))}
          ${line("Payment", escapeHtml(paymentMethodLabel(r.method, r.cardLast4)))}
          ${line("For", escapeHtml(r.forLabel))}
          <tr>
            <td style="padding:13px 0 0;font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#8A857E;">Amount received</td>
            <td style="padding:13px 0 0;text-align:right;"><span style="font-family:Georgia,'Times New Roman',serif;font-size:24px;font-weight:700;color:#1A1A1A;">${gbp(r.amount)}</span></td>
          </tr>
        </table>
      </td></tr>
    </table>
  </td></tr>`;
}

/** The receipt block as a template variable (empty string when absent). */
export const receiptBlockVar = (receipt?: ReceiptDetails | null): string =>
  receipt ? receiptDetailsBlock(receipt) : "";

/* ------------------------------------------------- template variables
   Each customer email prefers its published Resend template (copy editable in
   the dashboard, no deploy); these helpers compose the send-time variables so
   the template path and the in-repo fallback builders below stay in step. */

const firstNameOf = (name: string | null | undefined): string =>
  (name ?? "").trim().split(/\s+/)[0] || "there";

export function depositReceivedTemplateVars(m: DepositReceivedMeta): Record<string, string> {
  const balanceLine =
    m.balanceAmount != null && m.balanceAmount > 0
      ? `Your remaining balance of <strong style="color:#1A1A1A;">${gbp(m.balanceAmount)}</strong> is due 24 hours before your move, unless we've agreed otherwise.`
      : `Your remaining balance is due 24 hours before your move, unless we've agreed otherwise.`;
  return {
    CUSTOMER_FIRST_NAME: firstNameOf(m.firstName),
    QUOTE_REF: escapeHtml(m.quoteRef),
    AMOUNT: gbp(m.amount),
    MOVE_DATE_LABEL: escapeHtml(m.moveDateLabel ?? "your booked date"),
    BALANCE_LINE: balanceLine,
    RECEIPT_BLOCK: receiptBlockVar(m.receipt),
  };
}

export function balanceInvoiceTemplateVars(m: BalanceInvoiceMeta): Record<string, string> {
  return {
    CUSTOMER_FIRST_NAME: firstNameOf(m.firstName),
    QUOTE_REF: escapeHtml(m.quoteRef),
    AMOUNT: gbp(m.amount),
    MOVE_DATE_CLAUSE: m.moveDateLabel
      ? ` on <strong style="color:#1A1A1A;">${escapeHtml(m.moveDateLabel)}</strong>`
      : "",
    INVOICE_META: m.invoiceNumber ? ` · Invoice ${escapeHtml(m.invoiceNumber)}` : "",
    INVOICE_BUTTON: m.invoiceUrl
      ? `  <tr><td align="center" style="padding:0 36px 22px;">
    <table cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#C03838" style="border-radius:6px;">
      <a href="${m.invoiceUrl}" style="display:inline-block;padding:15px 38px;background:#C03838;color:#FFFFFF;font-size:14px;font-weight:600;text-decoration:none;border-radius:6px;letter-spacing:0.04em;">View your invoice &rarr;</a>
    </td></tr></table>
  </td></tr>`
      : "",
  };
}

export function balanceReceivedTemplateVars(m: {
  firstName?: string | null;
  quoteRef: string;
  amount: number;
  moveDateLabel?: string | null;
  receipt?: ReceiptDetails | null;
}): Record<string, string> {
  return {
    CUSTOMER_FIRST_NAME: firstNameOf(m.firstName),
    QUOTE_REF: escapeHtml(m.quoteRef),
    AMOUNT: gbp(m.amount),
    MOVE_DAY_LABEL: escapeHtml(m.moveDateLabel ?? "move day"),
    RECEIPT_BLOCK: receiptBlockVar(m.receipt),
  };
}

/* ------------------------------------------------- deposit received */

export interface DepositReceivedMeta {
  firstName?: string | null;
  quoteRef: string;
  amount: number;
  moveDateLabel?: string | null; // pre-formatted, e.g. "Monday 20 July"
  balanceAmount?: number | null; // remaining balance, if known
  receipt?: ReceiptDetails | null; // folds a formal receipt panel into the email
}

export function buildDepositReceivedEmailHtml(m: DepositReceivedMeta): string {
  const name = (m.firstName ?? "").trim().split(/\s+/)[0];
  const when = m.moveDateLabel
    ? ` for your move on <strong style="color:#1A1A1A;">${escapeHtml(m.moveDateLabel)}</strong>`
    : "";
  const balanceLine =
    m.balanceAmount != null && m.balanceAmount > 0
      ? `Your remaining balance of <strong style="color:#1A1A1A;">${gbp(m.balanceAmount)}</strong> is due 24 hours before your move, unless we've agreed otherwise.`
      : `Your remaining balance is due 24 hours before your move, unless we've agreed otherwise.`;

  // When we have receipt detail, the receipt panel carries the amount (and more);
  // otherwise fall back to the simple "Deposit paid £X" card.
  const amountPanel = m.receipt
    ? receiptDetailsBlock(m.receipt)
    : `  <tr><td style="padding:0 36px 26px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border:1.5px solid #1A1A1A;border-radius:8px;overflow:hidden;">
      <tr><td style="padding:20px 26px;border-left:4px solid #C03838;">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.22em;color:#6E6A65;margin-bottom:6px;">Deposit paid</div>
        <div style="font-family:Georgia,'Times New Roman',serif;font-size:36px;font-weight:700;color:#1A1A1A;letter-spacing:-0.02em;line-height:1;">${gbp(m.amount)}</div>
      </td></tr>
    </table>
  </td></tr>`;

  const inner = [
    pill(`Deposit received · ${escapeHtml(m.quoteRef)}`),
    headline(`You're booked in${name ? ", " + escapeHtml(name) : ""}`),
    subline(
      `We have received your ${gbp(m.amount)} deposit${when}. Your date and team are now secured.`,
    ),
    amountPanel,
    subline(
      `${balanceLine} Any questions in the meantime, call Connor on <strong style="color:#C03838;">01747 637070</strong> or just reply to this email.`,
    ),
  ].join("\n");

  return shell(
    `Your ${gbp(m.amount)} deposit is received. Your move date is secured.`,
    inner,
  );
}

/** Balance received → "all settled, see you on move day". */
export function buildBalanceReceivedEmailHtml(m: {
  firstName?: string | null;
  quoteRef: string;
  amount: number;
  moveDateLabel?: string | null;
  receipt?: ReceiptDetails | null;
}): string {
  const name = (m.firstName ?? "").trim().split(/\s+/)[0];
  const when = m.moveDateLabel
    ? ` We will see you on <strong style="color:#1A1A1A;">${escapeHtml(m.moveDateLabel)}</strong>.`
    : ` We will see you on move day.`;
  const inner = [
    pill(`Payment received · ${escapeHtml(m.quoteRef)}`),
    headline(`All settled${name ? ", " + escapeHtml(name) : ""}`),
    subline(
      `We have received your balance of <strong style="color:#1A1A1A;">${gbp(m.amount)}</strong>, so there is nothing more to pay.${when} Any last-minute questions, call Connor on <strong style="color:#C03838;">01747 637070</strong>.`,
    ),
    ...(m.receipt ? [receiptDetailsBlock(m.receipt)] : []),
  ].join("\n");
  return shell(`Balance of ${gbp(m.amount)} received. You're all set for move day.`, inner);
}

/* ------------------------------------------------- review request */

/** Post-move "how did we do?" — the Google review ask. Sent once per lead,
 *  after the move completes, only when a review URL is configured. */
export function buildReviewRequestEmailHtml(m: {
  firstName?: string | null;
  reviewUrl: string;
}): string {
  const name = (m.firstName ?? "").trim().split(/\s+/)[0];
  const inner = [
    pill("Move complete"),
    headline(`How did we do${name ? ", " + escapeHtml(name) : ""}?`),
    subline(
      `That's your move done. Thank you for choosing Marley Moves. If Connor and the crew looked after you, a quick Google review makes a real difference to a small local firm like ours. It takes about a minute.`,
    ),
    `  <tr><td align="center" style="padding:0 36px 22px;">
    <table cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#C03838" style="border-radius:6px;">
      <a href="${m.reviewUrl}" style="display:inline-block;padding:15px 38px;background:#C03838;color:#FFFFFF;font-size:14px;font-weight:600;text-decoration:none;border-radius:6px;letter-spacing:0.04em;">Leave a Google review &rarr;</a>
    </td></tr></table>
  </td></tr>`,
    subline(
      `And if anything wasn't right, please reply to this email or call Connor on <strong style="color:#C03838;">01747 637070</strong> first. We would always rather fix it.`,
    ),
  ].join("\n");
  return shell(`Thanks for moving with Marley Moves. A quick review helps us a lot.`, inner);
}

/* ------------------------------------------------- balance invoice */

export interface BalanceInvoiceMeta {
  firstName?: string | null;
  quoteRef: string;
  amount: number;
  moveDateLabel?: string | null;
  /** Hosted Zoho invoice page — a "view your invoice" link only. The balance
   *  is deliberately BACS/cash-only (card fees are too high at these values;
   *  Peter, 2026-07-09) — never card copy here, even once Stripe is live. */
  invoiceUrl?: string | null;
  invoiceNumber?: string | null;
}

export function buildBalanceInvoiceEmailHtml(m: BalanceInvoiceMeta): string {
  const name = (m.firstName ?? "").trim().split(/\s+/)[0];
  const when = m.moveDateLabel
    ? ` on <strong style="color:#1A1A1A;">${escapeHtml(m.moveDateLabel)}</strong>`
    : "";
  const btn = m.invoiceUrl
    ? `  <tr><td align="center" style="padding:0 36px 22px;">
    <table cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#C03838" style="border-radius:6px;">
      <a href="${m.invoiceUrl}" style="display:inline-block;padding:15px 38px;background:#C03838;color:#FFFFFF;font-size:14px;font-weight:600;text-decoration:none;border-radius:6px;letter-spacing:0.04em;">View your invoice &rarr;</a>
    </td></tr></table>
  </td></tr>`
    : "";

  const inner = [
    pill(`Final balance · ${escapeHtml(m.quoteRef)}`),
    headline(`Your final balance${name ? ", " + escapeHtml(name) : ""}`),
    subline(
      `Ahead of your move${when}, here is the final balance. Payment in full is due before move day so everything is settled and the crew can focus on the job.`,
    ),
    `  <tr><td style="padding:0 36px 22px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border:1.5px solid #1A1A1A;border-radius:8px;overflow:hidden;">
      <tr><td style="padding:20px 26px;border-left:4px solid #C03838;">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.22em;color:#6E6A65;margin-bottom:6px;">Balance due${
          m.invoiceNumber ? ` · Invoice ${escapeHtml(m.invoiceNumber)}` : ""
        }</div>
        <div style="font-family:Georgia,'Times New Roman',serif;font-size:36px;font-weight:700;color:#1A1A1A;letter-spacing:-0.02em;line-height:1;">${gbp(m.amount)}</div>
        <div style="font-size:11px;color:#6E6A65;margin-top:6px;">Your ${escapeHtml(m.quoteRef)} deposit is already accounted for.</div>
      </td></tr>
    </table>
  </td></tr>`,
    btn,
    bankCard(m.quoteRef),
    subline(
      `Already paid or need a different arrangement? Call Connor on <strong style="color:#C03838;">01747 637070</strong> or reply to this email.`,
    ),
  ].join("\n");

  return shell(`Your final balance of ${gbp(m.amount)} is due before move day.`, inner);
}
