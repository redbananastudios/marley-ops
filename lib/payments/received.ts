/**
 * "Payments received" day view — pure assembly so the maths is testable.
 *
 * Two sources today:
 *   card      takepayments attempts (card_payments) settled or refunded in the
 *             day — the gateway is money-truth for these.
 *   recorded  deposits/commitments/balances marked paid in the panel (BACS
 *             one-tap, cash, bank-feed confirm) — quotes.deposit_paid_at /
 *             quotes.commitment_paid_at / leads.balance_paid_at stamps.
 *
 * A third source arrives with the bank feed (Revolut/Monzo webhook): inbound
 * transfers matched by reference. It slots in as another ReceivedItem source —
 * the page already leaves the seam.
 *
 * Dedupe rule: a card-paid deposit ALSO stamps quotes.deposit_paid_at (same
 * instant, via markDepositPaid), so any quote with a card receipt in the window
 * is dropped from the recorded list — otherwise every card deposit counts twice.
 *
 * Test attempts (is_test) are listed — seeing the simulator charge appear here
 * proves the loop — but never counted in totals.
 */

import { ukInstant, ukParts } from "@/lib/uk-time";

/* ------------------------------------------------------------------ window */

export interface UkDayWindow {
  /** YYYY-MM-DD of the UK calendar day shown. */
  day: string;
  start: Date;
  end: Date;
  prev: string;
  next: string;
  isToday: boolean;
}

const pad = (n: number): string => String(n).padStart(2, "0");
const isoDay = (y: number, m: number, d: number): string =>
  new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);

/** Resolve a ?date=YYYY-MM-DD param (default today) to UK-midnight bounds. */
export function ukDayWindow(dateParam?: string | null, now: Date = new Date()): UkDayWindow {
  const today = ukParts(now);
  let y = today.year;
  let m = today.month;
  let d = today.day;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateParam ?? "");
  if (match) {
    const [py, pm, pd] = [Number(match[1]), Number(match[2]), Number(match[3])];
    // Round-trip through Date.UTC rejects impossible dates like 2026-02-31.
    if (isoDay(py, pm, pd) === `${match[1]}-${match[2]}-${match[3]}`) {
      y = py;
      m = pm;
      d = pd;
    }
  }
  return {
    day: `${y}-${pad(m)}-${pad(d)}`,
    start: ukInstant(y, m, d),
    end: ukInstant(y, m, d + 1),
    prev: isoDay(y, m, d - 1),
    next: isoDay(y, m, d + 1),
    isToday: y === today.year && m === today.month && d === today.day,
  };
}

/* ------------------------------------------------------------------- items */

export interface ReceivedItem {
  key: string;
  source: "card" | "recorded";
  /** refund rows carry a negative amount. */
  kind: "deposit" | "commitment" | "balance" | "refund";
  customer: string;
  quoteRef: string | null;
  leadId: string | null;
  amountPence: number;
  /** ISO instant the money event happened (sort key + display time). */
  at: string;
  /** card only — drives the status badge. */
  cardStatus?: string;
  cardMask?: string | null;
  cardScheme?: string | null;
  isTest?: boolean;
  note?: string | null;
}

export interface CardRowIn {
  id: string;
  kind: string;
  status: string;
  amount_pence: number;
  refunded_pence: number;
  is_test: boolean;
  settled_at: string | null;
  refunded_at: string | null;
  refund_reason: string | null;
  quote_id: string;
  lead_id: string | null;
  card_number_mask: string | null;
  card_scheme: string | null;
}

export interface QuoteIn {
  id: string;
  quote_ref: string;
  lead_id: string | null;
  customer_name: string | null;
  agreed_price: number | null;
  grand_total: number | null;
  deposit_amount: number | null;
  deposit_paid_at: string | null;
  balance_invoice_amount: number | null;
  commitment_invoice_amount?: number | null;
  commitment_paid_at?: string | null;
}

export interface LeadIn {
  id: string;
  name: string | null;
  balance_paid_at: string | null;
  balance_amount: number | null;
}

export interface ReceivedDay {
  items: ReceivedItem[];
  /** Net pence per bucket — refunds subtract; test rows never count. */
  cardPence: number;
  recordedPence: number;
  totalPence: number;
}

const poundsToPence = (n: number | null | undefined): number => Math.round(Number(n ?? 0) * 100);

/** Gateway states that represent money having been taken at some point. */
const CARD_MONEY_STATUSES = new Set([
  "paid",
  "partially_refunded",
  "refunded",
  "voided",
  "needs_review",
]);

export function buildReceivedDay(input: {
  window: Pick<UkDayWindow, "start" | "end">;
  cardRows: CardRowIn[];
  /** Quotes with deposit_paid_at inside the window. */
  depositQuotes: QuoteIn[];
  /** Quotes with commitment_paid_at inside the window (BACS/cash only — the
   *  commitment invoice never takes card, so no card-dedupe is needed). */
  commitmentQuotes?: QuoteIn[];
  /** Leads with balance_paid_at inside the window. */
  balanceLeads: LeadIn[];
  /** The lead's money quote (most recently accepted) for names/amounts. */
  quoteByLeadId: Map<string, QuoteIn>;
}): ReceivedDay {
  const startMs = input.window.start.getTime();
  const endMs = input.window.end.getTime();
  const inWindow = (iso: string | null): boolean => {
    if (!iso) return false;
    const t = new Date(iso).getTime();
    return t >= startMs && t < endMs;
  };

  const items: ReceivedItem[] = [];
  // Quotes whose card receipt already counts in the window — their recorded
  // deposit stamp is the SAME money and must not double-count.
  const cardCoveredQuoteIds = new Set<string>();

  for (const row of input.cardRows) {
    if (!CARD_MONEY_STATUSES.has(row.status)) continue;
    const quote = input.quoteByLeadId.get(row.lead_id ?? "") ?? null;
    const base = {
      source: "card" as const,
      customer: quote?.customer_name || "Customer",
      quoteRef: quote?.quote_ref ?? null,
      leadId: row.lead_id,
      cardStatus: row.status,
      cardMask: row.card_number_mask,
      cardScheme: row.card_scheme,
      isTest: row.is_test,
    };
    if (inWindow(row.settled_at)) {
      cardCoveredQuoteIds.add(row.quote_id);
      items.push({
        ...base,
        key: `card:${row.id}`,
        kind: row.kind === "balance" ? "balance" : "deposit",
        amountPence: row.amount_pence,
        at: row.settled_at!,
      });
    }
    if (inWindow(row.refunded_at) && row.refunded_pence > 0) {
      // refunded_pence is cumulative; if partial refunds ever span days this
      // line shows the running total on the latest refund's day. Rare enough
      // that precision isn't worth a per-refund ledger yet.
      items.push({
        ...base,
        key: `card-refund:${row.id}`,
        kind: "refund",
        amountPence: -row.refunded_pence,
        at: row.refunded_at!,
        note: row.refund_reason,
      });
    }
  }

  for (const q of input.depositQuotes) {
    if (!inWindow(q.deposit_paid_at) || cardCoveredQuoteIds.has(q.id)) continue;
    items.push({
      key: `deposit:${q.id}`,
      source: "recorded",
      kind: "deposit",
      customer: q.customer_name || "Customer",
      quoteRef: q.quote_ref,
      leadId: q.lead_id,
      amountPence: poundsToPence(q.deposit_amount),
      at: q.deposit_paid_at!,
    });
  }

  for (const q of input.commitmentQuotes ?? []) {
    if (!inWindow(q.commitment_paid_at ?? null)) continue;
    items.push({
      key: `commitment:${q.id}`,
      source: "recorded",
      kind: "commitment",
      customer: q.customer_name || "Customer",
      quoteRef: q.quote_ref,
      leadId: q.lead_id,
      amountPence: poundsToPence(q.commitment_invoice_amount),
      at: q.commitment_paid_at!,
    });
  }

  for (const lead of input.balanceLeads) {
    if (!inWindow(lead.balance_paid_at)) continue;
    const quote = input.quoteByLeadId.get(lead.id) ?? null;
    const agreed = Number(quote?.agreed_price ?? quote?.grand_total ?? 0);
    const deposit = Number(quote?.deposit_amount ?? 0);
    // A RAISED commitment invoice is carved out of the balance (invoices
    // partition the agreed price — computeBalanceCredits doctrine).
    const commitment = Number(quote?.commitment_invoice_amount ?? 0);
    const balance =
      lead.balance_amount ?? quote?.balance_invoice_amount ?? Math.max(0, agreed - deposit - commitment);
    items.push({
      key: `balance:${lead.id}`,
      source: "recorded",
      kind: "balance",
      customer: quote?.customer_name || lead.name || "Customer",
      quoteRef: quote?.quote_ref ?? null,
      leadId: lead.id,
      amountPence: poundsToPence(balance),
      at: lead.balance_paid_at!,
    });
  }

  items.sort((a, b) => b.at.localeCompare(a.at));

  const cardPence = items
    .filter((i) => i.source === "card" && !i.isTest)
    .reduce((s, i) => s + i.amountPence, 0);
  const recordedPence = items
    .filter((i) => i.source === "recorded")
    .reduce((s, i) => s + i.amountPence, 0);

  return { items, cardPence, recordedPence, totalPence: cardPence + recordedPence };
}
