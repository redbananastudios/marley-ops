/**
 * Weekly owner digest — PURE aggregation (the cron route does the IO).
 *
 * Peter's spec (2026-07-16): a brief Monday email to Connor + Peter, "how the
 * business ran this week versus the week before", easy to digest. A "week" is
 * a UK Monday→Sunday; the digest always reports the most recently COMPLETED
 * week against the one before it, so the numbers never move under a reader.
 */

import { ukInstant, ukParts, UK_TZ } from "@/lib/uk-time";

/* ------------------------------------------------------------------ windows */

export interface WeekWindow {
  /** Inclusive start (UK Monday 00:00) … exclusive end (next Monday 00:00). */
  start: Date;
  end: Date;
  /** "7–13 Jul" — customer-free, for the subject + column heads. */
  label: string;
}

const weekdayFmt = new Intl.DateTimeFormat("en-GB", { timeZone: UK_TZ, weekday: "short" });
const dayMonthFmt = new Intl.DateTimeFormat("en-GB", { timeZone: UK_TZ, day: "numeric", month: "short" });

function weekLabel(start: Date, end: Date): string {
  const lastDay = new Date(end.getTime() - 1);
  return `${dayMonthFmt.format(start)} – ${dayMonthFmt.format(lastDay)}`;
}

/** The completed UK week before `now`, and the week before that. */
export function digestWeeks(now: Date): { thisWeek: WeekWindow; lastWeek: WeekWindow } {
  const dowIdx = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(weekdayFmt.format(now));
  const p = ukParts(now);
  const currentMonday = ukInstant(p.year, p.month, p.day - (dowIdx < 0 ? 0 : dowIdx));
  const thisStart = ukInstant(p.year, p.month, p.day - (dowIdx < 0 ? 0 : dowIdx) - 7);
  const lastStart = ukInstant(p.year, p.month, p.day - (dowIdx < 0 ? 0 : dowIdx) - 14);
  return {
    thisWeek: { start: thisStart, end: currentMonday, label: weekLabel(thisStart, currentMonday) },
    lastWeek: { start: lastStart, end: thisStart, label: weekLabel(lastStart, thisStart) },
  };
}

const inWindow = (iso: string | null | undefined, w: WeekWindow): boolean => {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t >= w.start.getTime() && t < w.end.getTime();
};

/* ------------------------------------------------------------------- inputs */

export interface DigestLeadIn {
  id: string;
  created_at: string;
  lost_at: string | null;
  balance_paid_at: string | null;
}

export interface DigestQuoteIn {
  lead_id: string | null;
  quote_ref: string;
  customer_name: string | null;
  email_sent_at: string | null;
  accepted_at: string | null;
  deposit_paid_at: string | null;
  deposit_amount: number | null;
  agreed_price: number | null;
  grand_total: number | null;
  balance_invoice_amount: number | null;
}

export interface DigestCompletionIn {
  created_at: string;
  exceptions: string;
}

export interface DigestApptIn {
  appt_type: string;
  status: string;
  starts_at: string | null;
}

/** Live counts read at send time (not week-windowed). */
export interface DigestSnapshotIn {
  bankTransfersPending: number;
  openFollowUps: number;
  storageUnitsActive: number;
  storageLetsOpen: number;
  /** Claims still live (open / assessing / offer made) — stage 2, 2026-07-16. */
  openClaims: number;
}

export interface DigestInputs {
  leads: DigestLeadIn[];
  quotes: DigestQuoteIn[];
  completions: DigestCompletionIn[];
  appointments: DigestApptIn[];
  snapshot: DigestSnapshotIn;
}

/* ------------------------------------------------------------------- output */

export interface WeekMetrics {
  enquiries: number;
  quotesSent: number;
  quotesSentValue: number;
  wins: number;
  winsValue: number;
  lost: number;
  jobsCompleted: number;
  surveysDone: number;
  moneyIn: number; // deposits + balances recorded in the panel
  exceptionsRecorded: number;
}

export interface WeeklyDigest {
  thisWeek: WeekWindow & WeekMetrics;
  lastWeek: WeekWindow & WeekMetrics;
  /** Biggest acceptance of the reported week, if any. */
  biggestWin: { quoteRef: string; firstName: string; value: number } | null;
  /** Forward look + live attention items at send time. */
  nextWeekMoves: number;
  nextWeekSurveys: number;
  snapshot: DigestSnapshotIn;
}

const num = (v: number | null | undefined): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
const quoteValue = (q: DigestQuoteIn): number => num(q.agreed_price) || num(q.grand_total);

function metricsFor(w: WeekWindow, input: DigestInputs): WeekMetrics {
  const balanceByLead = new Map<string, number>();
  for (const q of input.quotes) {
    if (q.lead_id && q.deposit_paid_at) {
      const bal = num(q.balance_invoice_amount) || Math.max(0, quoteValue(q) - num(q.deposit_amount));
      balanceByLead.set(q.lead_id, Math.max(balanceByLead.get(q.lead_id) ?? 0, bal));
    }
  }

  const deposits = input.quotes
    .filter((q) => inWindow(q.deposit_paid_at, w))
    .reduce((sum, q) => sum + num(q.deposit_amount), 0);
  const balances = input.leads
    .filter((l) => inWindow(l.balance_paid_at, w))
    .reduce((sum, l) => sum + (balanceByLead.get(l.id) ?? 0), 0);

  const sent = input.quotes.filter((q) => inWindow(q.email_sent_at, w));
  const won = input.quotes.filter((q) => inWindow(q.accepted_at, w));

  return {
    enquiries: input.leads.filter((l) => inWindow(l.created_at, w)).length,
    quotesSent: sent.length,
    quotesSentValue: sent.reduce((s, q) => s + quoteValue(q), 0),
    wins: won.length,
    winsValue: won.reduce((s, q) => s + quoteValue(q), 0),
    lost: input.leads.filter((l) => inWindow(l.lost_at, w)).length,
    jobsCompleted: input.completions.filter((c) => inWindow(c.created_at, w)).length,
    surveysDone: input.appointments.filter(
      (a) => a.appt_type === "survey" && a.status !== "cancelled" && inWindow(a.starts_at, w),
    ).length,
    moneyIn: deposits + balances,
    exceptionsRecorded: input.completions.filter(
      (c) => inWindow(c.created_at, w) && c.exceptions.trim().length > 0,
    ).length,
  };
}

export function buildWeeklyDigest(input: DigestInputs, now: Date): WeeklyDigest {
  const { thisWeek, lastWeek } = digestWeeks(now);

  const winsThisWeek = input.quotes
    .filter((q) => inWindow(q.accepted_at, thisWeek) && quoteValue(q) > 0)
    .sort((a, b) => quoteValue(b) - quoteValue(a));
  const top = winsThisWeek[0];
  const firstName = (name: string | null): string => (name ?? "").trim().split(/\s+/)[0] || "a customer";

  const nextWeekEnd = new Date(now.getTime() + 7 * 86_400_000);
  const upcoming = (type: string) =>
    input.appointments.filter((a) => {
      if (a.appt_type !== type || a.status === "cancelled" || !a.starts_at) return false;
      const t = Date.parse(a.starts_at);
      return Number.isFinite(t) && t >= now.getTime() && t < nextWeekEnd.getTime();
    }).length;

  return {
    thisWeek: { ...thisWeek, ...metricsFor(thisWeek, input) },
    lastWeek: { ...lastWeek, ...metricsFor(lastWeek, input) },
    biggestWin: top ? { quoteRef: top.quote_ref, firstName: firstName(top.customer_name), value: quoteValue(top) } : null,
    nextWeekMoves: upcoming("removal"),
    nextWeekSurveys: upcoming("survey"),
    snapshot: input.snapshot,
  };
}

/* --------------------------------------------------------------- formatting */

export const gbp = (n: number): string =>
  `£${n.toLocaleString("en-GB", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

/** "↑", "↓" or "—" vs last week — the only comparison decoration in the email. */
export function trendArrow(current: number, previous: number): string {
  if (current > previous) return "▲";
  if (current < previous) return "▼";
  return "—";
}
