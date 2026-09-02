/**
 * Refund-queue customer emails (Payments Policy v2 — PRD §5D/§5E):
 *
 *  - Refund executed   → ONE email when a queue row completes, itemising every
 *    rail that was returned, with the 14-day promise line.
 *  - Retained outcome  → when the old date stayed empty: "held against your
 *    original date" framing, itemising anything refunded above the 25% held.
 *    Deliberately NO credit note (HMRC forfeited-deposit position).
 *
 * Same visual language as payment-email.ts (logo on white, Georgia headline,
 * red accent). Pure server utils — no React, no DOM. UK English, no em dashes.
 * Amounts always VAT-inclusive gross. The word "penalty" appears NOWHERE here,
 * by policy (test-enforced in tests/lib/refund-emails.test.ts).
 *
 * Each email prefers its published Resend template (env ids, editable in the
 * dashboard, no deploy); the builders below are the in-repo fallback. The
 * variable helpers keep the two paths in step.
 *
 * Multi-brand (docs/multi-brand-prd.md §3.5): metas take an optional `brand`;
 * absent/marley renders today's exact bytes via the default theme in
 * lib/comms/email-brand.ts (the shell and pill are the shared brand-aware
 * fragments there).
 */

import type { Brand } from "@/lib/brand";
import { emailTheme, themedEmailShell, themedPill, type EmailTheme } from "@/lib/comms/email-brand";

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

/* --------------------------------------------------------------- line items */

/** One returned (or retained) payment shown to the customer. */
export interface RefundLine {
  /** e.g. "Deposit", "Commitment payment", "Card deposit". */
  label: string;
  /** e.g. "back to your card ending 4242", "by bank transfer", "by bank transfer to the account you gave us". */
  railLabel: string;
  amount: number;
}

function lineRows(lines: RefundLine[]): string {
  return lines
    .map(
      (l) => `<tr>
    <td style="padding:9px 0;border-bottom:1px solid #F0EDE8;font-size:13px;color:#1A1A1A;">${escapeHtml(l.label)}<span style="color:#8A857E;"> · ${escapeHtml(l.railLabel)}</span></td>
    <td align="right" style="padding:9px 0;border-bottom:1px solid #F0EDE8;font-size:14px;color:#1A1A1A;font-weight:600;white-space:nowrap;">${gbp(l.amount)}</td>
  </tr>`,
    )
    .join("\n");
}

function amountsCard(title: string, lines: RefundLine[], totalLabel: string, total: number, t: EmailTheme): string {
  return `  <tr><td style="padding:0 36px 22px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FAFAFA;border-radius:8px;overflow:hidden;">
      <tr><td style="padding:20px 24px;">
        <div style="font-size:10px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#6E6A65;margin-bottom:10px;">${title}</div>
        <table width="100%" cellpadding="0" cellspacing="0">
          ${lineRows(lines)}
          <tr>
            <td style="padding:10px 0 0;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#8A857E;">${totalLabel}</td>
            <td align="right" style="padding:10px 0 0;font-size:16px;color:${t.accent};font-weight:700;white-space:nowrap;">${gbp(total)}</td>
          </tr>
        </table>
      </td></tr>
    </table>
  </td></tr>`;
}

/** The 14-day promise line, shared verbatim by both paths. */
export const REFUND_SLA_LINE =
  "Card refunds normally show on your statement within 3 to 5 working days and bank transfers usually arrive the same day, all well within the 14 days we promise.";

/** The same promise for a brand whose card channel is not live. */
const REFUND_SLA_LINE_NO_CARD =
  "Bank transfers usually arrive the same day, well within the 14 days we promise.";

/**
 * The one line of refund copy that names a payment rail, so it follows the
 * brand's card switch like every other card mention (PRD §11.10). A brand that
 * never offered card cannot have a card refund to explain, and the word is
 * scrubbed from its every other surface.
 *
 * It must be resolved HERE rather than left to the hosted template's card-free
 * fallback_value: SLA_LINE is supplied on every send, and a supplied variable
 * always beats a fallback, so gating only the fallback would change nothing a
 * customer reads.
 */
export function refundSlaLine(t: EmailTheme): string {
  return t.cardPhone ? REFUND_SLA_LINE : REFUND_SLA_LINE_NO_CARD;
}

/* ------------------------------------------------------- refund executed */

export interface RefundExecutedMeta {
  firstName?: string | null;
  quoteRef: string;
  lines: RefundLine[];
  totalRefund: number;
  /** Sending brand — absent/marley renders today's exact bytes. */
  brand?: Brand | null;
}

export function refundExecutedTemplateVars(m: RefundExecutedMeta): Record<string, string> {
  return {
    CUSTOMER_FIRST_NAME: escapeHtml(firstNameOf(m.firstName)),
    QUOTE_REF: escapeHtml(m.quoteRef),
    TOTAL_REFUND: gbp(m.totalRefund),
    REFUND_LINES: lineRows(m.lines),
    SLA_LINE: refundSlaLine(emailTheme(m.brand)),
  };
}

export function buildRefundExecutedEmailHtml(m: RefundExecutedMeta): string {
  const t = emailTheme(m.brand);
  const name = firstNameOf(m.firstName);
  const inner = [
    themedPill(`Refund complete · ${escapeHtml(m.quoteRef)}`, t),
    headline(`Your refund is on its way${name !== "there" ? ", " + escapeHtml(name) : ""}`),
    subline(
      `We have now returned everything due back to you for booking ${escapeHtml(m.quoteRef)}. Each payment goes back the way it came in.`,
    ),
    amountsCard("Refunded to you", m.lines, "Total refunded", m.totalRefund, t),
    subline(refundSlaLine(t)),
    subline(
      `Any questions at all, just reply to this email or ${t.callUsHtml}.`,
    ),
  ].join("\n");
  return themedEmailShell(`Your ${gbp(m.totalRefund)} refund from ${t.name} is on its way.`, inner, t);
}

/* ------------------------------------------------------ retained outcome */

export interface RetainedOutcomeMeta {
  firstName?: string | null;
  quoteRef: string;
  /** Pre-formatted, e.g. "Friday 14 August". */
  originalDateLabel: string | null;
  retainedTotal: number;
  /** Anything refunded above the 25% held — may be empty. */
  refundLines: RefundLine[];
  refundTotal: number;
  /** Sending brand — absent/marley renders today's exact bytes. */
  brand?: Brand | null;
}

export function retainedOutcomeTemplateVars(m: RetainedOutcomeMeta): Record<string, string> {
  const t = emailTheme(m.brand);
  const dateClause = m.originalDateLabel
    ? ` of <strong style="color:#1A1A1A;">${escapeHtml(m.originalDateLabel)}</strong>`
    : "";
  return {
    CUSTOMER_FIRST_NAME: escapeHtml(firstNameOf(m.firstName)),
    QUOTE_REF: escapeHtml(m.quoteRef),
    ORIGINAL_DATE_CLAUSE: dateClause,
    RETAINED_AMOUNT: gbp(m.retainedTotal),
    REFUND_SECTION:
      m.refundLines.length > 0
        ? amountsCard("Refunded to you", m.refundLines, "Total refunded", m.refundTotal, t) +
          "\n" +
          subline(refundSlaLine(t))
        : "",
  };
}

export function buildRetainedOutcomeEmailHtml(m: RetainedOutcomeMeta): string {
  const t = emailTheme(m.brand);
  const name = firstNameOf(m.firstName);
  const dateClause = m.originalDateLabel
    ? ` of <strong style="color:#1A1A1A;">${escapeHtml(m.originalDateLabel)}</strong>`
    : "";
  const refundBits =
    m.refundLines.length > 0
      ? [
          subline(
            `Anything you paid above that held amount has been refunded in full, as promised:`,
          ),
          amountsCard("Refunded to you", m.refundLines, "Total refunded", m.refundTotal, t),
          subline(refundSlaLine(t)),
        ]
      : [];
  const inner = [
    themedPill(`Booking update · ${escapeHtml(m.quoteRef)}`, t),
    headline(`About your original move date${name !== "there" ? ", " + escapeHtml(name) : ""}`),
    subline(
      `Despite our best efforts, we were not able to re-book your original move date${dateClause}. As set out in your booking terms, <strong style="color:#1A1A1A;">${gbp(m.retainedTotal)}</strong> of what you had paid has been held against that date. Had the day re-booked, it would have been refunded in full.`,
    ),
    ...refundBits,
    subline(
      `If anything here does not look right, or you would like to talk it through, just reply to this email or ${t.callUsHtml}.`,
    ),
  ].join("\n");
  return themedEmailShell(
    `An update on your booking ${m.quoteRef} and your original move date.`,
    inner,
    t,
  );
}
