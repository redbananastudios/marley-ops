/**
 * Finance — invoices-raised engine (pure, no I/O). Shapes the Zoho invoice list
 * into the day view + VAT rollups the /finance page renders.
 *
 * VAT basis: every invoice the business raises is VAT-INCLUSIVE at the UK
 * standard 20% rate (deposits, balances, storage — the Zoho org's 20% rate
 * itemises them on the documents). So output VAT = gross − gross/1.2, computed
 * PER INVOICE then summed, matching how each invoice document rounds. If a
 * zero-rated invoice is ever raised by hand in Zoho, this view will overstate
 * VAT for it — the page carries that caveat, and the quarterly return is
 * always prepared from Zoho/the accountant, not from here.
 */

export interface FinanceInvoice {
  invoiceId: string;
  invoiceNumber: string;
  reference: string;
  customerName: string;
  date: string; // yyyy-mm-dd invoice date
  status: string; // draft | sent | viewed | paid | partially_paid | overdue | void
  total: number; // gross, VAT-inclusive
  balance: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** MarleyMoves Ltd is VAT-registered with effect from this date (HMRC VRT22C
 *  approval letter, issued 06 Jun 2026, VAT no. 520 2213 58). Invoices dated
 *  before it were raised outside the VAT regime and carry NO VAT — without
 *  this floor, browsing historical days would ascribe VAT to them. */
export const VAT_REGISTERED_FROM = "2026-06-01";

/** VAT portion of a 20%-inclusive gross (gross − net). £100 → £16.67. */
export const vatFromGross = (gross: number): number => round2(gross - gross / 1.2);

/** Ex-VAT portion of a 20%-inclusive gross. £100 → £83.33. */
export const netFromGross = (gross: number): number => round2(gross / 1.2);

/** VAT on ONE invoice, respecting the registration date: zero before
 *  VAT_REGISTERED_FROM (an undated row is assumed current-era). */
export const invoiceVat = (inv: Pick<FinanceInvoice, "date" | "total">): number =>
  inv.date && inv.date < VAT_REGISTERED_FROM ? 0 : vatFromGross(inv.total);

/** Raised = actually issued: drafts aren't out the door and voids never count. */
export const isRaised = (status: string): boolean => status !== "void" && status !== "draft";

export interface RaisedSummary {
  count: number;
  gross: number;
  net: number;
  vat: number;
}

/** Totals over the ISSUED invoices in a set (voids/drafts excluded). */
export function summariseRaised(invoices: FinanceInvoice[]): RaisedSummary {
  const live = invoices.filter((i) => isRaised(i.status));
  const gross = round2(live.reduce((s, i) => s + i.total, 0));
  // Per-invoice VAT then sum — matches the invoice documents' own rounding —
  // and zero for anything dated before VAT registration.
  const vat = round2(live.reduce((s, i) => s + invoiceVat(i), 0));
  return { count: live.length, gross, vat, net: round2(gross - vat) };
}

/** Money still owed across a set of invoices (issued only). */
export function outstandingTotal(invoices: FinanceInvoice[]): number {
  return round2(
    invoices.filter((i) => isRaised(i.status)).reduce((s, i) => s + Math.max(0, i.balance), 0),
  );
}

/* ------------------------------------------------- plain-date day helpers */

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Today as a UK calendar day (invoice dates are plain dates in UK terms). */
export const ukTodayDate = (now: Date = new Date()): string =>
  now.toLocaleDateString("en-CA", { timeZone: "Europe/London" });

/** Valid yyyy-mm-dd within sane bounds (extreme years break date maths). */
export const isValidDay = (s: string | undefined): s is string =>
  typeof s === "string" &&
  DAY_RE.test(s) &&
  s >= "2000-01-01" &&
  s <= "2100-12-31" &&
  !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

/** yyyy-mm-dd ± n days (UTC-safe — plain dates, no wall-clock involved). */
export function addDaysIso(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** First day of the given day's month. */
export const monthStart = (day: string): string => `${day.slice(0, 8)}01`;

/* --------------------------------------------------- VAT quarter (stagger) */

/** HMRC stagger group: 1 = quarters ending Mar/Jun/Sep/Dec, 2 = Apr/Jul/Oct/Jan,
 *  3 = May/Aug/Nov/Feb. Set in Settings from the VAT certificate. */
export type VatStaggerGroup = 1 | 2 | 3;

/** Months (1-12) that START a quarter, per stagger group. */
const QUARTER_START_MONTHS: Record<VatStaggerGroup, number[]> = {
  1: [1, 4, 7, 10], // ends Mar / Jun / Sep / Dec
  2: [2, 5, 8, 11], // ends Apr / Jul / Oct / Jan
  3: [3, 6, 9, 12], // ends May / Aug / Nov / Feb
};

export interface VatQuarter {
  start: string; // yyyy-mm-01
  end: string; // yyyy-mm-dd (last day of the quarter)
}

/** The VAT quarter containing `day` for the given stagger group. */
export function vatQuarterFor(day: string, group: VatStaggerGroup): VatQuarter {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  const starts = QUARTER_START_MONTHS[group];
  // Latest quarter-start at or before this month; if none (group 2/3 in the
  // year's opening months) the quarter began late LAST year.
  const startMonth = [...starts].reverse().find((s) => s <= m);
  const startYear = startMonth === undefined ? y - 1 : y;
  const sm = startMonth ?? starts[starts.length - 1];
  const start = `${startYear}-${String(sm).padStart(2, "0")}-01`;
  // Last day of the quarter = the day before the month 3 months on.
  const end = new Date(Date.UTC(startYear, sm - 1 + 3, 1) - 86_400_000).toISOString().slice(0, 10);
  return { start, end };
}

/** "1 Jul – 30 Sep 2026" style label. */
export function vatQuarterLabel(q: VatQuarter): string {
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", timeZone: "UTC" };
  const s = new Date(`${q.start}T00:00:00Z`).toLocaleDateString("en-GB", opts);
  const e = new Date(`${q.end}T00:00:00Z`).toLocaleDateString("en-GB", { ...opts, year: "numeric" });
  return `${s} – ${e}`;
}

/** "Tuesday 15 July 2026" style label for the day header. */
export function dayLabel(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
