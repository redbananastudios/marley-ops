/**
 * Branded payment emails — same visual language as quote-email.ts (logo on
 * white, Georgia display headline, red accent, charcoal ink).
 *
 *  - Deposit received  → "You're booked in" confirmation.
 *  - Balance invoice   → "Your final balance" request (pre-move, payment in
 *    full before the job), with BACS details + the hosted Zoho invoice link.
 *
 * Multi-brand (docs/multi-brand-prd.md §3.5): every meta takes an optional
 * `brand`; absent/null/marley renders BYTE-IDENTICAL to the single-brand
 * output (the default theme in lib/comms/email-brand.ts IS today's literals).
 * Non-default brands render their own chrome plus the required disclosures:
 * payment goes to MarleyMoves Ltd (inside the bank block) and a Marley Moves
 * vehicle or crew may attend (booking confirmation / pre-move copy).
 *
 * Pure server utils — no React, no DOM. UK English, no em-dashes.
 */

import type { Brand } from "@/lib/brand";
import {
  emailTheme,
  themedBankCard,
  themedButtonRow,
  themedEmailShell,
  themedPill,
  type EmailTheme,
} from "@/lib/comms/email-brand";

// Canonical home moved to email-brand.ts (the theme needs it for disclosure
// (a) without a circular import); re-exported here for existing importers.
export { BANK_DETAILS } from "@/lib/comms/email-brand";

const gbp = (n: number): string =>
  "£" +
  Number(n)
    .toFixed(2)
    .replace(/\.00$/, "")
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
 * amount received — house style (bordered card, accent left border, Georgia
 * amount). Pure; every interpolated value is HTML-escaped. Used as both the
 * in-repo block and the `{{RECEIPT_BLOCK}}` template variable so the two stay
 * in step — which is why it takes the theme: the fragment lands inside a
 * brand's own hosted template and must not inject Marley red there.
 */
export function receiptDetailsBlock(r: ReceiptDetails, t: EmailTheme = emailTheme()): string {
  const line = (label: string, value: string) => `<tr>
            <td style="padding:9px 0;border-bottom:1px solid #F0EDE8;font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#8A857E;width:44%;">${label}</td>
            <td style="padding:9px 0;border-bottom:1px solid #F0EDE8;font-size:14px;color:#1A1A1A;font-weight:600;text-align:right;">${value}</td>
          </tr>`;
  return `  <tr><td style="padding:0 36px 24px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border:1.5px solid #1A1A1A;border-radius:8px;overflow:hidden;">
      <tr><td style="padding:20px 26px;border-left:4px solid ${t.accent};">
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
export const receiptBlockVar = (receipt?: ReceiptDetails | null, t: EmailTheme = emailTheme()): string =>
  receipt ? receiptDetailsBlock(receipt, t) : "";

/* ------------------------------------------------- template variables
   Each customer email prefers its published Resend template (copy editable in
   the dashboard, no deploy); these helpers compose the send-time variables so
   the template path and the in-repo fallback builders below stay in step.
   A non-default brand's hosted set carries its own copy + disclosures (§11.7
   trap 4), so the vars only need the brand for the HTML fragments they inject. */

const firstNameOf = (name: string | null | undefined): string =>
  (name ?? "").trim().split(/\s+/)[0] || "there";

export function depositReceivedTemplateVars(m: DepositReceivedMeta): Record<string, string> {
  const t = emailTheme(m.brand);
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
    RECEIPT_BLOCK: receiptBlockVar(m.receipt, t),
  };
}

export function balanceInvoiceTemplateVars(m: BalanceInvoiceMeta): Record<string, string> {
  const t = emailTheme(m.brand);
  return {
    CUSTOMER_FIRST_NAME: firstNameOf(m.firstName),
    QUOTE_REF: escapeHtml(m.quoteRef),
    AMOUNT: gbp(m.amount),
    MOVE_DATE_CLAUSE: m.moveDateLabel
      ? ` on <strong style="color:#1A1A1A;">${escapeHtml(m.moveDateLabel)}</strong>`
      : "",
    INVOICE_META: m.invoiceNumber ? ` · Invoice ${escapeHtml(m.invoiceNumber)}` : "",
    INVOICE_BUTTON: m.invoiceUrl
      ? themedButtonRow(m.invoiceUrl, "View your invoice &rarr;", t)
      : "",
  };
}

export function balanceReceivedTemplateVars(m: {
  firstName?: string | null;
  quoteRef: string;
  amount: number;
  moveDateLabel?: string | null;
  receipt?: ReceiptDetails | null;
  brand?: Brand | null;
}): Record<string, string> {
  return {
    CUSTOMER_FIRST_NAME: firstNameOf(m.firstName),
    QUOTE_REF: escapeHtml(m.quoteRef),
    AMOUNT: gbp(m.amount),
    MOVE_DAY_LABEL: escapeHtml(m.moveDateLabel ?? "move day"),
    RECEIPT_BLOCK: receiptBlockVar(m.receipt, emailTheme(m.brand)),
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
  /** Sending brand — absent/marley renders today's exact bytes. */
  brand?: Brand | null;
}

export function buildDepositReceivedEmailHtml(m: DepositReceivedMeta): string {
  const t = emailTheme(m.brand);
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
    ? receiptDetailsBlock(m.receipt, t)
    : `  <tr><td style="padding:0 36px 26px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border:1.5px solid #1A1A1A;border-radius:8px;overflow:hidden;">
      <tr><td style="padding:20px 26px;border-left:4px solid ${t.accent};">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.22em;color:#6E6A65;margin-bottom:6px;">Deposit paid</div>
        <div style="font-family:Georgia,'Times New Roman',serif;font-size:36px;font-weight:700;color:#1A1A1A;letter-spacing:-0.02em;line-height:1;">${gbp(m.amount)}</div>
      </td></tr>
    </table>
  </td></tr>`;

  const inner = [
    themedPill(`Deposit received · ${escapeHtml(m.quoteRef)}`, t),
    headline(`You're booked in${name ? ", " + escapeHtml(name) : ""}`),
    subline(
      `We have received your ${gbp(m.amount)} deposit${when}. Your date and team are now secured.`,
    ),
    amountPanel,
    // Disclosure (b) — a booking confirmation for a non-default brand notes a
    // Marley vehicle/crew may attend; empty for marley, so no row renders.
    ...(t.attendNoteHtml ? [subline(t.attendNoteHtml)] : []),
    subline(
      `${balanceLine} Any questions in the meantime, ${t.callHtml} or just reply to this email.`,
    ),
  ].join("\n");

  return themedEmailShell(
    `Your ${gbp(m.amount)} deposit is received. Your move date is secured.`,
    inner,
    t,
  );
}

/** Balance received → "all settled, see you on move day". */
export function buildBalanceReceivedEmailHtml(m: {
  firstName?: string | null;
  quoteRef: string;
  amount: number;
  moveDateLabel?: string | null;
  receipt?: ReceiptDetails | null;
  brand?: Brand | null;
}): string {
  const t = emailTheme(m.brand);
  const name = (m.firstName ?? "").trim().split(/\s+/)[0];
  const when = m.moveDateLabel
    ? ` We will see you on <strong style="color:#1A1A1A;">${escapeHtml(m.moveDateLabel)}</strong>.`
    : ` We will see you on move day.`;
  const inner = [
    themedPill(`Payment received · ${escapeHtml(m.quoteRef)}`, t),
    headline(`All settled${name ? ", " + escapeHtml(name) : ""}`),
    subline(
      `We have received your balance of <strong style="color:#1A1A1A;">${gbp(m.amount)}</strong>, so there is nothing more to pay.${when} Any last-minute questions, ${t.callHtml}.`,
    ),
    ...(m.receipt ? [receiptDetailsBlock(m.receipt, t)] : []),
    // Disclosure (b) — the last pre-move touch: the customer should not be
    // surprised by the livery that turns up.
    ...(t.attendNoteHtml ? [subline(t.attendNoteHtml)] : []),
  ].join("\n");
  return themedEmailShell(`Balance of ${gbp(m.amount)} received. You're all set for move day.`, inner, t);
}

/* ------------------------------------------------- review request */

/** Post-move "how did we do?" — the review ask. Sent once per lead, after the
 *  move completes. The platform names whichever link we chose for this
 *  customer (Google / Trustpilot / Checkatrade) so the copy never claims
 *  Google while the button goes elsewhere. */
export function buildReviewRequestEmailHtml(m: {
  firstName?: string | null;
  reviewUrl: string;
  platform?: string;
  brand?: Brand | null;
}): string {
  const t = emailTheme(m.brand);
  const name = (m.firstName ?? "").trim().split(/\s+/)[0];
  const platform = escapeHtml((m.platform ?? "Google").trim() || "Google");
  const crew = t.isDefault ? "Connor and the crew" : "the team";
  const inner = [
    themedPill("Move complete", t),
    headline(`How did we do${name ? ", " + escapeHtml(name) : ""}?`),
    subline(
      `That's your move done. Thank you for choosing ${escapeHtml(t.name)}. If ${crew} looked after you, a quick ${platform} review makes a real difference to a small local firm like ours. It takes about a minute.`,
    ),
    themedButtonRow(m.reviewUrl, `Leave a ${platform} review &rarr;`, t),
    subline(
      `And if anything wasn't right, please reply to this email or ${t.callHtml} first. We would always rather fix it.`,
    ),
  ].join("\n");
  return themedEmailShell(`Thanks for moving with ${t.name}. A quick review helps us a lot.`, inner, t);
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
  /** Sending brand — absent/marley renders today's exact bytes. */
  brand?: Brand | null;
}

export function buildBalanceInvoiceEmailHtml(m: BalanceInvoiceMeta): string {
  const t = emailTheme(m.brand);
  const name = (m.firstName ?? "").trim().split(/\s+/)[0];
  const when = m.moveDateLabel
    ? ` on <strong style="color:#1A1A1A;">${escapeHtml(m.moveDateLabel)}</strong>`
    : "";
  const btn = m.invoiceUrl ? themedButtonRow(m.invoiceUrl, "View your invoice &rarr;", t) : "";

  const inner = [
    themedPill(`Final balance · ${escapeHtml(m.quoteRef)}`, t),
    headline(`Your final balance${name ? ", " + escapeHtml(name) : ""}`),
    subline(
      `Ahead of your move${when}, here is the final balance. Payment in full is due before move day so everything is settled and the crew can focus on the job.`,
    ),
    `  <tr><td style="padding:0 36px 22px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border:1.5px solid #1A1A1A;border-radius:8px;overflow:hidden;">
      <tr><td style="padding:20px 26px;border-left:4px solid ${t.accent};">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.22em;color:#6E6A65;margin-bottom:6px;">Balance due${
          m.invoiceNumber ? ` · Invoice ${escapeHtml(m.invoiceNumber)}` : ""
        }</div>
        <div style="font-family:Georgia,'Times New Roman',serif;font-size:36px;font-weight:700;color:#1A1A1A;letter-spacing:-0.02em;line-height:1;">${gbp(m.amount)}</div>
        <div style="font-size:11px;color:#6E6A65;margin-top:6px;">Your ${escapeHtml(m.quoteRef)} deposit is already accounted for.</div>
      </td></tr>
    </table>
  </td></tr>`,
    btn,
    themedBankCard(m.quoteRef, t),
    // Disclosure (b) — pre-move: the crew that arrives may be Marley-liveried.
    ...(t.attendNoteHtml ? [subline(t.attendNoteHtml)] : []),
    subline(
      `Already paid or need a different arrangement? ${t.callHtmlCap} or reply to this email.`,
    ),
  ].join("\n");

  return themedEmailShell(`Your final balance of ${gbp(m.amount)} is due before move day.`, inner, t);
}
