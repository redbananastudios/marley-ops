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
        <div style="font-size:10px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#6E6A65;margin-bottom:10px;">Pay by bank transfer</div>
        <table width="100%" cellpadding="0" cellspacing="0">
          ${row("Account name", BANK_DETAILS.name)}
          ${row("Sort code", BANK_DETAILS.sortCode)}
          ${row("Account number", BANK_DETAILS.account)}
          <tr>
            <td style="padding:8px 0;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#8A857E;">Reference</td>
            <td style="padding:8px 0;font-size:14px;color:#C03838;font-weight:700;">${escapeHtml(reference)}</td>
          </tr>
        </table>
      </td></tr>
    </table>
  </td></tr>`;
}

/* ------------------------------------------------- deposit received */

export interface DepositReceivedMeta {
  firstName?: string | null;
  quoteRef: string;
  amount: number;
  moveDateLabel?: string | null; // pre-formatted, e.g. "Monday 20 July"
  balanceAmount?: number | null; // remaining balance, if known
}

export function buildDepositReceivedEmailHtml(m: DepositReceivedMeta): string {
  const name = (m.firstName ?? "").trim().split(/\s+/)[0];
  const when = m.moveDateLabel
    ? ` for your move on <strong style="color:#1A1A1A;">${escapeHtml(m.moveDateLabel)}</strong>`
    : "";
  const balanceLine =
    m.balanceAmount != null && m.balanceAmount > 0
      ? `The remaining balance of <strong style="color:#1A1A1A;">${gbp(m.balanceAmount)}</strong> is due before move day. We will send your final invoice nearer the time.`
      : `We will send your final invoice nearer the time. The balance is due before move day.`;

  const inner = [
    pill(`Deposit received · ${escapeHtml(m.quoteRef)}`),
    headline(`You're booked in${name ? ", " + escapeHtml(name) : ""}`),
    subline(
      `We have received your ${gbp(m.amount)} deposit${when}. Your date and team are now secured.`,
    ),
    `  <tr><td style="padding:0 36px 26px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border:1.5px solid #1A1A1A;border-radius:8px;overflow:hidden;">
      <tr><td style="padding:20px 26px;border-left:4px solid #C03838;">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.22em;color:#6E6A65;margin-bottom:6px;">Deposit paid</div>
        <div style="font-family:Georgia,'Times New Roman',serif;font-size:36px;font-weight:700;color:#1A1A1A;letter-spacing:-0.02em;line-height:1;">${gbp(m.amount)}</div>
      </td></tr>
    </table>
  </td></tr>`,
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
  ].join("\n");
  return shell(`Balance of ${gbp(m.amount)} received. You're all set for move day.`, inner);
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
