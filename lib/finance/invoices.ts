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

/** VAT portion of a 20%-inclusive gross (gross − net). £100 → £16.67. */
export const vatFromGross = (gross: number): number => round2(gross - gross / 1.2);

/** Ex-VAT portion of a 20%-inclusive gross. £100 → £83.33. */
export const netFromGross = (gross: number): number => round2(gross / 1.2);

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
  // Per-invoice VAT then sum — matches the invoice documents' own rounding.
  const vat = round2(live.reduce((s, i) => s + vatFromGross(i.total), 0));
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
