/**
 * Cancellation / date-change customer emails + the pure planning helpers the
 * booking-change actions and dialogs share (Payments Policy v2 —
 * docs/payments-policy-v2-prd.md §5C/§5E).
 *
 * Three builders, same visual language as payment-email.ts (logo on white,
 * Georgia display headline, red accent):
 *
 *  - cancellation-ack          → inside-window date change: old date released,
 *    new date booked, held money provisionally counts toward the new booking.
 *  - marley-cancel             → we cancelled: apology + full refund of
 *    everything, no questions.
 *  - date-change-confirmation  → outside-window change: everything rolls,
 *    booking stays confirmed, amounts restated.
 *
 * Every amount shown to a customer is VAT-inclusive gross. The word "penalty"
 * NEVER appears anywhere in this file (test-enforced): held money is "held
 * against your original date — refunded in full if we re-book it."
 *
 * The pure planning helpers live HERE (not in app/actions/booking-change.ts)
 * because that file is "use server" and may only export async actions — pure
 * synchronous logic must sit in a lib module to stay unit-testable.
 *
 * Multi-brand (docs/multi-brand-prd.md §3.5): metas take an optional `brand`;
 * absent/marley renders today's exact bytes via the default theme in
 * lib/comms/email-brand.ts. The date-change confirmations are pre-move comms,
 * so non-default brands carry the Marley-crew-may-attend disclosure.
 *
 * Pure server utils — no React, no DOM, no IO. UK English, no em-dashes.
 */

import {
  COMMITMENT_PCT,
  REFUND_CUSTOMER_SLA_DAYS,
  isInsideChangeWindow,
  type HeldPayment,
  type HeldSplit,
  type PaymentRail,
} from "@/lib/payments-policy";
import type { Brand } from "@/lib/brand";
import { emailTheme, themedEmailShell, themedPill, type EmailTheme } from "@/lib/comms/email-brand";

/* ---------------------------------------------------- pure planning helpers */

export type BookingChangeMode = "reschedule" | "cancel_rebook";

/**
 * Which path a date change takes, judged against the ORIGINAL move day:
 * outside the 7-day window → a free reschedule (everything rolls); inside →
 * cancel-and-rebook with a refund-queue entry. A missing old move day has no
 * window to be inside, so it stays a plain reschedule.
 */
export function bookingChangeMode(
  oldMoveDay: string | null | undefined,
  today: Date = new Date(),
): BookingChangeMode {
  return isInsideChangeWindow(oldMoveDay ?? null, today) ? "cancel_rebook" : "reschedule";
}

/**
 * The conditional/unconditional amounts a refund-queue row records. Retention
 * only exists AFTER the customer confirmed their move date — before that,
 * nothing is retainable, so everything held is unconditional and the 25%-cap
 * split is deliberately ignored. With these amounts, either answer to the
 * fill question produces the right money outcome by construction (retainable
 * is £0 pre-confirmation).
 */
export function queueAmountsFor(
  split: HeldSplit,
  dateConfirmed: boolean,
): { conditional: number; unconditional: number } {
  if (!dateConfirmed) return { conditional: 0, unconditional: split.total };
  return { conditional: split.conditional, unconditional: split.unconditional };
}

const RAIL_LABEL: Record<PaymentRail, string> = {
  card: "card",
  bank_transfer: "bank transfer",
  cash: "cash",
};

const gbp = (n: number): string =>
  "£" +
  Number(n)
    .toFixed(2)
    .replace(/\.00$/, "")
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** "£100 deposit by bank transfer" — one display line per held payment. */
export function heldLines(held: HeldPayment[]): string[] {
  return held.map((p) => `${gbp(p.amount)}${p.label ? ` ${p.label}` : ""} by ${RAIL_LABEL[p.rail]}`);
}

/* -------------------------------------------------------- office dialog copy
   Shared by the change-date and cancel-booking dialogs so the wording lives in
   ONE place and the "penalty"-free test walks it. Amounts are shown separately
   by the dialogs — these carry the policy sentences verbatim. */

export const INSIDE_WINDOW_CHANGE_WARNING =
  "This change is within 7 days of the original move date. The original date will be released and everything already paid is held against it — refunded in full if we re-book the day. If the day stays empty, amounts paid up to 25% of the job price may be retained. No new deposit is taken: held money still counts towards the new booking.";

export const CANCEL_CONFIRMED_WARNING =
  "The move date was confirmed, so what has been paid is held against the booked date, capped at 25% of the job price — refunded in full if we re-book the day. Anything above the cap is refunded regardless. The decision lands in the refund review queue; nothing is refunded or retained without a button press there.";

export const CANCEL_UNCONFIRMED_NOTE =
  "The move date was never confirmed, so everything paid is refunded in full. The refund lands in the review queue ready to execute.";

export const MARLEY_CANCEL_NOTE =
  "We are cancelling, so everything the customer has paid is refunded in full — no re-booking question. An apology email goes out and unpaid invoices are voided.";

/* ------------------------------------------------------------- email rows
   The shell and pill render through the shared brand-aware fragments in
   lib/comms/email-brand.ts — the default theme is byte-identical to the old
   self-contained shell. */

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

/** The "already paid / refunded" amount card with the per-payment lines. */
/**
 * Amount-card fragment for the REGISTERED Resend templates ({{{HELD_CARD}}} /
 * {{{REFUND_CARD}}}) — injected only when money was actually paid, so a £0
 * card never renders. Markup mirrors `amountCard` in
 * scripts/create-resend-templates.mjs EXACTLY (Montserrat, warm-grey border)
 * so the fragment is indistinguishable from the template's own cards — keep
 * the two in lockstep like the branded-shell constants.
 */
export function templateAmountCard(
  caption: string,
  amount: number,
  lines: string[],
  t: EmailTheme = emailTheme(),
): string {
  const font = "'Montserrat','Segoe UI',Helvetica,Arial,sans-serif";
  const note = lines.length
    ? `\n        <div style="font-size:11px;color:#8A857E;margin-top:8px;">${lines.map((l) => escapeHtml(l)).join("<br>")}</div>`
    : "";
  return `  <tr><td style="padding:0 36px 22px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E7E4DE;border-radius:8px;overflow:hidden;">
      <tr><td style="padding:20px 26px;border-left:4px solid ${t.accent};">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.22em;color:#8A857E;margin-bottom:6px;">${escapeHtml(caption)}</div>
        <div style="font-family:${font};font-size:34px;font-weight:300;color:#1A1A1A;letter-spacing:-0.02em;line-height:1;">${gbp(amount)}</div>${note}
      </td></tr>
    </table>
  </td></tr>`;
}

function amountCard(caption: string, amount: number, lines: string[], t: EmailTheme): string {
  const lineHtml = lines.length
    ? `<div style="font-size:12px;color:#6E6A65;margin-top:8px;line-height:1.8;">${lines
        .map((l) => escapeHtml(l))
        .join("<br>")}</div>`
    : "";
  return `  <tr><td style="padding:0 36px 22px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border:1.5px solid #1A1A1A;border-radius:8px;overflow:hidden;">
      <tr><td style="padding:20px 26px;border-left:4px solid ${t.accent};">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.22em;color:#6E6A65;margin-bottom:6px;">${escapeHtml(caption)}</div>
        <div style="font-family:Georgia,'Times New Roman',serif;font-size:36px;font-weight:700;color:#1A1A1A;letter-spacing:-0.02em;line-height:1;">${gbp(amount)}</div>
        ${lineHtml}
      </td></tr>
    </table>
  </td></tr>`;
}

const firstNameOf = (name: string | null | undefined): string =>
  (name ?? "").trim().split(/\s+/)[0] || "";

const capPctLabel = `${Math.round(COMMITMENT_PCT * 100)}%`;

const SLA_SENTENCE = `Any refund that becomes due reaches you within ${REFUND_CUSTOMER_SLA_DAYS} days, back the way you paid.`;

/* ------------------------------------- cancellation-ack (inside-window change) */

export interface CancellationAckMeta {
  firstName?: string | null;
  quoteRef: string;
  /** Pre-formatted labels, e.g. "Monday 20 July". */
  oldDateLabel?: string | null;
  newDateLabel?: string | null;
  heldTotal: number;
  /** Slice held against the old date (refunded in full if it re-books). */
  conditionalAmount: number;
  /** Slice that counts toward the new booking regardless. */
  unconditionalAmount: number;
  /** Display lines from heldLines(). */
  heldLines: string[];
  /** Whether the customer had confirmed the date (drives the held framing). */
  dateConfirmed: boolean;
  /** Sending brand — absent/marley renders today's exact bytes. */
  brand?: Brand | null;
}

export function cancellationAckSubject(m: CancellationAckMeta): string {
  return `Your move date has changed (${m.quoteRef})`;
}

function ackHeldSentences(m: CancellationAckMeta): string[] {
  if (!m.dateConfirmed || m.conditionalAmount <= 0) {
    return [
      `Everything you've paid simply moves with you to the new date. Nothing changes and there's nothing to do.`,
    ];
  }
  const out = [
    `Because this change is within 7 days of your original date, ${gbp(m.conditionalAmount)} of what you've paid is held against ${
      m.oldDateLabel ?? "your original date"
    }. If we re-book that day, it counts towards your new date in full.`,
    `If the day stays empty, up to that amount (capped at ${capPctLabel} of your job price) may be retained.`,
  ];
  if (m.unconditionalAmount > 0) {
    out.push(
      `The remaining ${gbp(m.unconditionalAmount)} counts towards your new booking whatever happens.`,
    );
  }
  out.push(SLA_SENTENCE);
  return out;
}

export function cancellationAckText(m: CancellationAckMeta): string {
  const t = emailTheme(m.brand);
  const name = firstNameOf(m.firstName);
  return [
    `Hi ${name || "there"},`,
    `We've released your original move date${m.oldDateLabel ? ` (${m.oldDateLabel})` : ""} and booked you in${
      m.newDateLabel ? ` for ${m.newDateLabel}` : " for your new date"
    } (${m.quoteRef}).`,
    `No new deposit is needed. You've paid ${gbp(m.heldTotal)}${
      m.heldLines.length ? ` (${m.heldLines.join(", ")})` : ""
    } and it still counts towards your move.`,
    ...ackHeldSentences(m),
    ...(t.attendNoteText ? [t.attendNoteText] : []),
    `Any questions, ${t.callText} or just reply to this email.`,
  ].join("\n\n");
}

export function cancellationAckTemplateVars(m: CancellationAckMeta): Record<string, string> {
  const t = emailTheme(m.brand);
  return {
    CUSTOMER_FIRST_NAME: escapeHtml(firstNameOf(m.firstName) || "there"),
    QUOTE_REF: escapeHtml(m.quoteRef),
    OLD_DATE_LABEL: escapeHtml(m.oldDateLabel ?? "your original date"),
    NEW_DATE_LABEL: escapeHtml(m.newDateLabel ?? "your new date"),
    HELD_CARD: m.heldTotal > 0 ? templateAmountCard("Already paid", m.heldTotal, m.heldLines, t) : "",
    HELD_SENTENCES: ackHeldSentences(m)
      .map((s) => escapeHtml(s))
      .join(" "),
  };
}

export function buildCancellationAckEmailHtml(m: CancellationAckMeta): string {
  const t = emailTheme(m.brand);
  const name = firstNameOf(m.firstName);
  const inner = [
    themedPill(`Date changed · ${escapeHtml(m.quoteRef)}`, t),
    headline(`Your move date has changed${name ? ", " + escapeHtml(name) : ""}`),
    subline(
      `We've released your original date${
        m.oldDateLabel ? ` of <strong style="color:#1A1A1A;">${escapeHtml(m.oldDateLabel)}</strong>` : ""
      } and booked you in${
        m.newDateLabel ? ` for <strong style="color:#1A1A1A;">${escapeHtml(m.newDateLabel)}</strong>` : " for your new date"
      }. No new deposit is needed. Everything you've already paid still counts towards your move.`,
    ),
    m.heldTotal > 0 ? amountCard("Already paid", m.heldTotal, m.heldLines, t) : "",
    subline(ackHeldSentences(m).map((s) => escapeHtml(s)).join(" ")),
    // Disclosure (b) — the booking rolls to a new date, so this is pre-move.
    t.attendNoteHtml ? subline(t.attendNoteHtml) : "",
    subline(
      `Any questions, ${t.callHtml} or just reply to this email.`,
    ),
  ]
    .filter(Boolean)
    .join("\n");
  return themedEmailShell(
    `Your move date has changed. Everything you've paid still counts towards your move.`,
    inner,
    t,
  );
}

/* ---------------------------------------------- marley-cancel (apology + refund) */

export interface MarleyCancelMeta {
  firstName?: string | null;
  quoteRef: string;
  moveDateLabel?: string | null;
  /** Everything held — refunded in full. */
  refundTotal: number;
  heldLines: string[];
  /** Sending brand — absent/marley renders today's exact bytes. */
  brand?: Brand | null;
}

export function marleyCancelSubject(m: MarleyCancelMeta): string {
  return `We're sorry: your move is cancelled (${m.quoteRef})`;
}

export function marleyCancelText(m: MarleyCancelMeta): string {
  const t = emailTheme(m.brand);
  const name = firstNameOf(m.firstName);
  const refund =
    m.refundTotal > 0
      ? `Everything you've paid, ${gbp(m.refundTotal)}${
          m.heldLines.length ? ` (${m.heldLines.join(", ")})` : ""
        }, comes back to you in full, the same way you paid it, within ${REFUND_CUSTOMER_SLA_DAYS} days. There's nothing you need to do.`
      : `You haven't paid anything towards this move, so there's nothing owed either way.`;
  return [
    `Hi ${name || "there"},`,
    `We're very sorry. We can't do your move${
      m.moveDateLabel ? ` on ${m.moveDateLabel}` : ""
    } and have had to cancel your booking (${m.quoteRef}). This one is on us.`,
    refund,
    `If we can help with your move on another date, ${t.callText}. We'd like to make it right.`,
  ].join("\n\n");
}

export function marleyCancelTemplateVars(m: MarleyCancelMeta): Record<string, string> {
  return {
    CUSTOMER_FIRST_NAME: escapeHtml(firstNameOf(m.firstName) || "there"),
    QUOTE_REF: escapeHtml(m.quoteRef),
    MOVE_DATE_CLAUSE: m.moveDateLabel
      ? ` on <strong style="color:#1A1A1A;">${escapeHtml(m.moveDateLabel)}</strong>`
      : "",
    REFUND_CARD: m.refundTotal > 0 ? templateAmountCard("Refunded in full", m.refundTotal, m.heldLines, emailTheme(m.brand)) : "",
    REFUND_SENTENCE:
      m.refundTotal > 0
        ? `Everything you've paid comes back to you in full, the same way you paid it, within ${REFUND_CUSTOMER_SLA_DAYS} days. There's nothing you need to do.`
        : `You haven't paid anything towards this move, so there's nothing owed either way.`,
  };
}

export function buildMarleyCancelEmailHtml(m: MarleyCancelMeta): string {
  const t = emailTheme(m.brand);
  const name = firstNameOf(m.firstName);
  const inner = [
    themedPill(`Booking cancelled · ${escapeHtml(m.quoteRef)}`, t),
    headline(`We're sorry${name ? ", " + escapeHtml(name) : ""}`),
    subline(
      `We can't do your move${
        m.moveDateLabel ? ` on <strong style="color:#1A1A1A;">${escapeHtml(m.moveDateLabel)}</strong>` : ""
      } and have had to cancel your booking. This one is on us, and we're sorry for the disruption.`,
    ),
    m.refundTotal > 0 ? amountCard("Refunded in full", m.refundTotal, m.heldLines, t) : "",
    subline(
      m.refundTotal > 0
        ? `Everything you've paid comes back to you in full, the same way you paid it, within ${REFUND_CUSTOMER_SLA_DAYS} days. There's nothing you need to do.`
        : `You haven't paid anything towards this move, so there's nothing owed either way.`,
    ),
    subline(
      `If we can help with your move on another date, ${t.callHtml}. We'd like to make it right.`,
    ),
  ]
    .filter(Boolean)
    .join("\n");
  return themedEmailShell(`We're sorry: we've had to cancel your move. Everything you've paid is refunded in full.`, inner, t);
}

/* --------------------------------- date-change-confirmation (outside window) */

export interface DateChangeConfirmationMeta {
  firstName?: string | null;
  quoteRef: string;
  oldDateLabel?: string | null;
  newDateLabel?: string | null;
  heldTotal: number;
  heldLines: string[];
  /** Unpaid commitment restated (null/0 = nothing due yet on that ladder rung). */
  commitmentAmount?: number | null;
  commitmentDueLabel?: string | null;
  /** Sending brand — absent/marley renders today's exact bytes. */
  brand?: Brand | null;
}

export function dateChangeConfirmationSubject(m: DateChangeConfirmationMeta): string {
  return `Your new move date is confirmed${m.newDateLabel ? `: ${m.newDateLabel}` : ""} (${m.quoteRef})`;
}

function commitmentSentence(m: DateChangeConfirmationMeta): string | null {
  if (!m.commitmentAmount || m.commitmentAmount <= 0) return null;
  return `Your commitment payment of ${gbp(m.commitmentAmount)} is now due${
    m.commitmentDueLabel ? ` by ${m.commitmentDueLabel}` : ""
  }. It moves with your date and still counts towards your final bill.`;
}

export function dateChangeConfirmationText(m: DateChangeConfirmationMeta): string {
  const t = emailTheme(m.brand);
  const name = firstNameOf(m.firstName);
  const commitment = commitmentSentence(m);
  return [
    `Hi ${name || "there"},`,
    `Your move${m.oldDateLabel ? ` has moved from ${m.oldDateLabel}` : " date has changed"} to ${
      m.newDateLabel ?? "your new date"
    } (${m.quoteRef}). Your booking carries straight over: same team, same price, nothing to re-do.`,
    m.heldTotal > 0
      ? `You've paid ${gbp(m.heldTotal)}${
          m.heldLines.length ? ` (${m.heldLines.join(", ")})` : ""
        } and it all still counts towards your move.`
      : null,
    commitment,
    t.attendNoteText || null,
    `Any questions, ${t.callText} or just reply to this email.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function dateChangeConfirmationTemplateVars(
  m: DateChangeConfirmationMeta,
): Record<string, string> {
  const commitment = commitmentSentence(m);
  return {
    CUSTOMER_FIRST_NAME: escapeHtml(firstNameOf(m.firstName) || "there"),
    QUOTE_REF: escapeHtml(m.quoteRef),
    OLD_DATE_LABEL: escapeHtml(m.oldDateLabel ?? "your original date"),
    NEW_DATE_LABEL: escapeHtml(m.newDateLabel ?? "your new date"),
    HELD_CARD: m.heldTotal > 0 ? templateAmountCard("Already paid", m.heldTotal, m.heldLines, emailTheme(m.brand)) : "",
    HELD_SENTENCE:
      m.heldTotal > 0
        ? `You've paid ${gbp(m.heldTotal)} and it all still counts towards your move.`
        : "",
    COMMITMENT_SENTENCE: commitment ? escapeHtml(commitment) : "",
  };
}

export function buildDateChangeConfirmationEmailHtml(m: DateChangeConfirmationMeta): string {
  const t = emailTheme(m.brand);
  const name = firstNameOf(m.firstName);
  const commitment = commitmentSentence(m);
  const inner = [
    themedPill(`Date changed · ${escapeHtml(m.quoteRef)}`, t),
    headline(
      m.newDateLabel
        ? `You're booked for ${escapeHtml(m.newDateLabel)}`
        : `Your new date is confirmed${name ? ", " + escapeHtml(name) : ""}`,
    ),
    subline(
      `Your move${
        m.oldDateLabel ? ` has moved from <strong style="color:#1A1A1A;">${escapeHtml(m.oldDateLabel)}</strong>` : " date has changed"
      } to <strong style="color:#1A1A1A;">${escapeHtml(
        m.newDateLabel ?? "your new date",
      )}</strong>. Your booking carries straight over: same team, same price, nothing to re-do.`,
    ),
    m.heldTotal > 0 ? amountCard("Already paid", m.heldTotal, m.heldLines, t) : "",
    m.heldTotal > 0
      ? subline(`It all still counts towards your move. Nothing extra is taken for the change.`)
      : "",
    commitment ? subline(escapeHtml(commitment)) : "",
    // Disclosure (b) — pre-move: a Marley vehicle or crew may attend.
    t.attendNoteHtml ? subline(t.attendNoteHtml) : "",
    subline(
      `Any questions, ${t.callHtml} or just reply to this email.`,
    ),
  ]
    .filter(Boolean)
    .join("\n");
  return themedEmailShell(
    `Your new move date is confirmed. Your booking and everything you've paid roll straight over.`,
    inner,
    t,
  );
}
