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
 * Multi-brand (docs/multi-brand-prd.md §3.5): metas take an optional `brand`;
 * absent/marley renders today's exact bytes via the default theme in
 * lib/comms/email-brand.ts. Non-default brands add the two required
 * disclosures (MarleyMoves Ltd account inside the bank block; Marley vehicle
 * or crew may attend).
 *
 * Pure server utils — no React, no DOM, no IO.
 */

import { receiptDetailsBlock, receiptBlockVar, type ReceiptDetails } from "@/lib/comms/payment-email";
import type { Brand } from "@/lib/brand";
import {
  emailTheme,
  themedBankCard,
  themedButtonRow,
  themedEmailShell,
  themedPill,
  type EmailTheme,
} from "@/lib/comms/email-brand";

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

/* ------------------------------------------------------------ house rows */

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

function amountCard(label: string, amount: number, t: EmailTheme, footnote?: string): string {
  return `  <tr><td style="padding:0 36px 22px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border:1.5px solid #1A1A1A;border-radius:8px;overflow:hidden;">
      <tr><td style="padding:20px 26px;border-left:4px solid ${t.accent};">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.22em;color:#6E6A65;margin-bottom:6px;">${label}</div>
        <div style="font-family:Georgia,'Times New Roman',serif;font-size:36px;font-weight:700;color:#1A1A1A;letter-spacing:-0.02em;line-height:1;">${gbp(amount)}</div>
        ${footnote ? `<div style="font-size:11px;color:#6E6A65;margin-top:6px;">${footnote}</div>` : ""}
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
  /**
   * What would remain after the commitment — the T-7 balance. Present only when
   * settling in full is genuinely on offer (PRD §3.10 Addition 3): the same
   * `payInFullAvailable` gate the /q page and the server action use, so the
   * email never advertises a choice the page would not honour.
   *
   * Absent/0 renders today's exact bytes.
   */
  balanceRemaining?: number | null;
  /**
   * Gate 9a small jobs: the caller's verdict that the frozen figures cover the
   * whole job — the acceptance ask was the gross, the commitment clamped to 0
   * and NO balance will ever be invoiced. Only meaningful alongside
   * `commitmentAmount: 0`; the zero-commitment copy then stops promising "your
   * remaining balance is due in full before move day" and a "final invoice
   * nearer the time" that will never exist.
   *
   * Absent/false renders today's exact bytes (jobs that DO carry a balance).
   */
  paidInFull?: boolean;
  /**
   * An ALREADY-ISSUED final balance invoice, gross. A late booking (PRD §3.10
   * Addition 2) raises AND emails the -BAL at ACCEPTANCE, and
   * `ensureCommitmentInvoice` then refuses to raise a commitment behind it —
   * so `commitmentAmount` arrives here as 0 for a reason that has nothing to
   * do with there being nothing to pay. Without this the zero-commitment copy
   * below told a customer holding an unpaid invoice that there was nothing to
   * pay right now and that we would send the final invoice nearer the time,
   * days before the move. This is the same signal /q renders as
   * `showBalanceCard` (app/q/[token]/page.tsx), so the two surfaces agree.
   *
   * Absent/0 renders today's exact bytes (no balance invoice raised yet).
   */
  balanceInvoiced?: number | null;
  /** That invoice's number, so the copy names the document already in the
   *  customer's inbox rather than describing a second one. */
  balanceInvoiceNumber?: string | null;
  /** The issued balance is settled (leads.balance_paid_at). The ask then
   *  becomes a reassurance: never ask twice for money already handed over. */
  balanceSettled?: boolean;
  /** Where the customer takes the choice — their own /q page. */
  payUrl?: string | null;
  /** Sending brand — absent/marley renders today's exact bytes. */
  brand?: Brand | null;
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

/** The final balance invoice that has ALREADY been raised, if any, and whether
 *  it is still owed. Both the block copy and the preheader branch on it, so it
 *  is derived once. */
function issuedBalance(m: DateConfirmationMeta): { amount: number; outstanding: boolean } {
  const amount = Number(m.balanceInvoiced ?? 0) > 0 ? Number(m.balanceInvoiced) : 0;
  return { amount, outstanding: amount > 0 && !m.balanceSettled };
}

function commitmentBlockHtml(m: DateConfirmationMeta, t: EmailTheme): string {
  if (m.commitmentAmount > 0) {
    // Settling in full is an OFFER, never a nudge: the 25% the customer agreed
    // is the card that comes first and the one the copy leads with. The second
    // card appears only when the /q page would actually honour the choice.
    const remaining = Number(m.balanceRemaining ?? 0) > 0 ? Number(m.balanceRemaining) : 0;
    const full = m.commitmentAmount + remaining;
    return [
      amountCard(
        `Commitment payment${m.invoiceNumber ? ` · Invoice ${escapeHtml(m.invoiceNumber)}` : ""}`,
        m.commitmentAmount,
        t,
        `${dueClausePlain(m.commitmentDueLabel)} · counts towards your final bill`,
      ),
      remaining > 0
        ? amountCard(
            "Or settle in full",
            full,
            t,
            "Nothing more to pay before your move",
          )
        : "",
      m.invoiceUrl ? themedButtonRow(m.invoiceUrl, "View your invoice &rarr;", t) : "",
      themedBankCard(m.quoteRef, t),
      subline(
        remaining > 0
          ? `Your commitment payment of <strong style="color:#1A1A1A;">${gbp(m.commitmentAmount)}</strong> is ${dueClause(m.commitmentDueLabel)}, and it counts towards your final bill. If you would rather clear it in one go, ${
              m.payUrl
                ? `<a href="${escapeHtml(m.payUrl)}" style="color:#1A1A1A;font-weight:600;">choose "settle in full" on your booking page</a>`
                : `choose "settle in full" on your booking page`
            } and we will send the final invoice straight away. Either way the bank reference stays the same.`
          : `Your commitment payment of <strong style="color:#1A1A1A;">${gbp(m.commitmentAmount)}</strong> is ${dueClause(m.commitmentDueLabel)}. It counts towards your final bill, and the remaining balance is due in full before move day.`,
      ),
    ]
      .filter(Boolean)
      .join("\n");
  }
  // An already-ISSUED final balance outranks both zero-commitment arms below,
  // exactly as it does on /q (`showBalanceCard` is checked before `paidInFull`
  // there, for the same reason): those arms speak about an invoice still to
  // come, and this customer is already holding one. The vocabulary is borrowed
  // from the balance invoice email itself (payment-email.ts) rather than
  // invented, so the two documents describe one debt in one voice. No card
  // copy: the balance is bank transfer, phone card or cash only (Peter,
  // 2026-07-09), and the invoice is raised with online payments disabled.
  const bal = issuedBalance(m);
  if (bal.amount > 0) {
    if (!bal.outstanding) {
      return subline(
        `Your deposit already covers the commitment for your booking, and your final balance of <strong style="color:#1A1A1A;">${gbp(bal.amount)}</strong> is settled in full, so there is nothing left to pay.`,
      );
    }
    return [
      amountCard(
        `Balance due${m.balanceInvoiceNumber ? ` · Invoice ${escapeHtml(m.balanceInvoiceNumber)}` : ""}`,
        bal.amount,
        t,
        "Payment in full is due before move day",
      ),
      themedBankCard(m.quoteRef, t),
      subline(
        `Your deposit already covers the commitment for your booking, so this final balance is all that is left to pay. We have already sent you that invoice${
          m.balanceInvoiceNumber ? ` (${escapeHtml(m.balanceInvoiceNumber)})` : ""
        }, and payment in full is due before move day. Already paid or need a different arrangement? ${t.callHtmlCap} or reply to this email.`,
      ),
    ].join("\n");
  }
  // Gate 9a: `paidInFull` is the caller's frozen-figures verdict that the
  // payment WAS the whole job — no balance will ever be invoiced, so the
  // with-balance sentence below would promise a document and a debit that
  // never come. Jobs that do carry a balance keep today's exact bytes.
  if (m.paidInFull) {
    return subline(
      `Your payment already covers your booking in full, so there is nothing more to pay.`,
    );
  }
  return subline(
    `Your deposit already covers the commitment for your booking, so there is nothing more to pay right now. Your remaining balance is due in full before move day and we will send the final invoice nearer the time.`,
  );
}

export function dateConfirmationTemplateVars(m: DateConfirmationMeta): Record<string, string> {
  const t = emailTheme(m.brand);
  return {
    CUSTOMER_FIRST_NAME: escapeHtml(firstNameOf(m.firstName)),
    QUOTE_REF: escapeHtml(m.quoteRef),
    MOVE_DATE_LABEL: escapeHtml(m.moveDateLabel ?? "your booked date"),
    DEPOSIT_AMOUNT: gbp(m.depositAmount),
    COMMITMENT_BLOCK: commitmentBlockHtml(m, t),
    HELD_POSITION_LINE,
  };
}

export function buildDateConfirmationEmailHtml(m: DateConfirmationMeta): string {
  const t = emailTheme(m.brand);
  const bal = issuedBalance(m);
  const name = (m.firstName ?? "").trim().split(/\s+/)[0];
  const when = m.moveDateLabel
    ? ` on <strong style="color:#1A1A1A;">${escapeHtml(m.moveDateLabel)}</strong>`
    : "";
  const inner = [
    themedPill(`Move date confirmed · ${escapeHtml(m.quoteRef)}`, t),
    headline(`Your date is locked in${name ? ", " + escapeHtml(name) : ""}`),
    subline(
      `Thank you for confirming your move${when}. Your <strong style="color:#1A1A1A;">${gbp(m.depositAmount)}</strong> deposit is now held against your booking: from this point it is non-refundable and still counts towards your final bill.`,
    ),
    commitmentBlockHtml(m, t),
    subline(HELD_POSITION_LINE),
    // Disclosure (b) — pre-move: a Marley vehicle or crew may attend.
    ...(t.attendNoteHtml ? [subline(t.attendNoteHtml)] : []),
    subline(
      `Any questions, ${t.callHtml} or just reply to this email.`,
    ),
  ].join("\n");

  return themedEmailShell(
    // The preheader is the line the customer reads in their inbox list, so it
    // branches on the same facts the block does — an unpaid issued invoice
    // must never be previewed as "nothing more to pay right now".
    m.commitmentAmount > 0
      ? `Your move date is confirmed. Your ${gbp(m.commitmentAmount)} commitment payment is ${
          m.commitmentDueLabel ? `due by ${m.commitmentDueLabel}` : "due now"
        }.`
      : bal.outstanding
        ? `Your move date is confirmed. Your ${gbp(bal.amount)} final balance is due before move day.`
        : bal.amount > 0
          ? `Your move date is confirmed. Your balance is settled in full, so there is nothing left to pay.`
          : m.paidInFull
            ? `Your move date is confirmed. Nothing more to pay.`
            : `Your move date is confirmed. Nothing more to pay right now.`,
    inner,
    t,
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
  /** Sending brand — absent/marley renders today's exact bytes. */
  brand?: Brand | null;
}

export function commitmentReceivedTemplateVars(m: CommitmentReceivedMeta): Record<string, string> {
  return {
    CUSTOMER_FIRST_NAME: escapeHtml(firstNameOf(m.firstName)),
    QUOTE_REF: escapeHtml(m.quoteRef),
    AMOUNT: gbp(m.amount),
    MOVE_DATE_LABEL: escapeHtml(m.moveDateLabel ?? "your booked date"),
    RECEIPT_BLOCK: receiptBlockVar(m.receipt, emailTheme(m.brand)),
  };
}

export function buildCommitmentReceivedEmailHtml(m: CommitmentReceivedMeta): string {
  const t = emailTheme(m.brand);
  const name = (m.firstName ?? "").trim().split(/\s+/)[0];
  const when = m.moveDateLabel
    ? ` for your move on <strong style="color:#1A1A1A;">${escapeHtml(m.moveDateLabel)}</strong>`
    : "";
  const inner = [
    themedPill(`Payment received · ${escapeHtml(m.quoteRef)}`, t),
    headline(`Commitment received${name ? ", " + escapeHtml(name) : ""}`),
    subline(
      `We have received your <strong style="color:#1A1A1A;">${gbp(m.amount)}</strong> commitment payment${when}. It counts towards your final bill.`,
    ),
    m.receipt ? receiptDetailsBlock(m.receipt, t) : amountCard("Commitment paid", m.amount, t),
    subline(
      `Your remaining balance is due in full before move day and we will send the final invoice nearer the time. Any questions, ${t.callHtml} or just reply to this email.`,
    ),
  ].join("\n");
  return themedEmailShell(
    `Your ${gbp(m.amount)} commitment payment is received. It counts towards your final bill.`,
    inner,
    t,
  );
}
