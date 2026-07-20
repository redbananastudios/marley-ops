/**
 * Estimator contractor-invoice maths (pure). An estimator (Luke) bills three
 * kinds of work each week — all fixed-fee, none hours-based, NO VAT:
 *
 *   survey      £50 per attended survey visit          (business_settings.estimator_fee)
 *   phone_quote £10 per telephone quote, no visit       (estimator_phone_quote_fee)
 *   commission  7.5% of the job value EX-VAT ON COMPLETION (estimator_commission_pct)
 *
 * Commission is earned on COMPLETION, never at deposit (Peter, 2026-07-19): a
 * cancelled job never completes, so it never earns commission — there is nothing
 * to claw back from the estimator. The office fetches the week's completed jobs,
 * attended surveys and phone quotes; this module turns them into invoice lines
 * and does the ex-VAT commission maths. Amount-only lines (no quantity/rate) —
 * the description carries the meaning.
 */

import { round2 } from "@/lib/staff/statements";
import { VAT_REGISTERED_FROM } from "@/lib/finance/invoices";

export interface EstimatorFees {
  /** £ per attended survey visit. */
  surveyFee: number;
  /** £ per telephone quote where the estimator did not attend a survey. */
  phoneQuoteFee: number;
  /** % of the ex-VAT job value, paid on completion. */
  commissionPct: number;
}

/**
 * Job value net of VAT. The customer invoice charges 20% inclusive, so a
 * VAT-enabled quote's stored total is GROSS → ex-VAT = gross / 1.2. A quote
 * raised before VAT registration (vatEnabled=false) is already ex-VAT.
 *
 * The Flat Rate Scheme is deliberately irrelevant here: the customer is charged
 * the full 20% regardless of scheme, so the value the estimator earns commission
 * on is the standard 20%-ex figure — NEVER divide by 1.10.
 */
export function jobValueExVat(value: number, vatEnabled: boolean): number {
  const v = Math.max(0, value || 0);
  return round2(vatEnabled ? v / 1.2 : v);
}

/** Commission on a completed job = pct% of the ex-VAT job value, to the penny. */
export function commissionAmount(value: number, vatEnabled: boolean, pct: number): number {
  return round2((jobValueExVat(value, vatEnabled) * Math.max(0, pct || 0)) / 100);
}

/**
 * Whether VAT was actually part of a job's price — the same registration-date
 * floor the finance page applies to invoices (lib/finance VAT_REGISTERED_FROM).
 * A job billed BEFORE registration carried no VAT even if the quote's vat_enabled
 * flag says otherwise, so its stored value is already ex-VAT and the estimator
 * earns commission on the full figure (never divided by 1.2). Without this floor a
 * pre-registration job with a stale vat_enabled=true flag would silently under-pay
 * the estimator. `jobDate` = the completion (billing) day; a missing date is
 * treated as current-era (VAT applies), matching the finance rule.
 */
export function jobVatApplies(quoteVatEnabled: boolean, jobDate: string | null): boolean {
  if (!quoteVatEnabled) return false;
  return !jobDate || jobDate.slice(0, 10) >= VAT_REGISTERED_FROM;
}

export interface SurveyVisit {
  /** Appointment id — the dedup key (per-visit fee, not per-lead). */
  apptId: string;
  leadId: string | null;
  customer: string;
  /** UK day of the visit (YYYY-MM-DD). */
  day: string;
}
export interface PhoneQuote {
  /** Lead id — the dedup key (one telephone fee per lead). */
  leadId: string;
  ref: string | null;
  customer: string;
  day: string;
}
export interface CompletedJob {
  /** Lead id — the dedup key (one commission per completed job). */
  leadId: string;
  ref: string | null;
  customer: string;
  /** UK completion (move) day. */
  day: string;
  /** Agreed job value; GROSS when vatEnabled, else already ex-VAT. */
  value: number;
  vatEnabled: boolean;
}

export interface NewEstimatorLine {
  description: string;
  work_date: string | null;
  quantity: number | null;
  unit_amount: number | null;
  amount: number;
  source: "survey" | "phone_quote" | "commission";
  /** Ledger keys so a fee is billed at most once EVER across statements: the
   *  survey visit (appointment) for survey lines, and the lead for phone/
   *  commission lines. The seed action excludes any already billed on another
   *  statement using these. */
  appointment_id: string | null;
  lead_id: string | null;
}

const day10 = (d: string): string => (d ?? "").slice(0, 10);
const byDay = <T extends { day: string }>(a: T, b: T): number => day10(a.day).localeCompare(day10(b.day));

/** Format a percentage cleanly: 7.5 → "7.5", 10 → "10". */
function pctLabel(pct: number): string {
  return String(round2(pct)).replace(/\.0$/, "");
}

/** £-format for the commission line's ex-VAT base (aids office review). */
function gbp(n: number): string {
  return "£" + n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Build the week's estimator invoice lines from the three event streams. The
 * caller (the seed action) has already scoped every input to THIS estimator and
 * THIS week and resolved ownership; this function only dedups, prices and orders.
 *
 *  - one line per attended survey visit (deduped by apptId),
 *  - one telephone-quote line per lead (deduped by leadId),
 *  - one commission line per completed job (deduped by leadId), skipping any
 *    whose value works out to £0.
 *
 * £0 lines are dropped (a misconfigured £0 fee or a valueless job shouldn't post
 * an empty line). Ordered survey → phone → commission, each by day.
 */
export function buildEstimatorLines({
  surveys,
  phoneQuotes,
  completions,
  fees,
}: {
  surveys: SurveyVisit[];
  phoneQuotes: PhoneQuote[];
  completions: CompletedJob[];
  fees: EstimatorFees;
}): NewEstimatorLine[] {
  const out: NewEstimatorLine[] = [];

  const seenSurvey = new Set<string>();
  for (const s of [...surveys].sort(byDay)) {
    if (seenSurvey.has(s.apptId)) continue;
    seenSurvey.add(s.apptId);
    const amount = round2(Math.max(0, fees.surveyFee));
    if (amount <= 0) continue;
    out.push({
      description: `Survey visit — ${s.customer}`,
      work_date: day10(s.day) || null,
      quantity: null,
      unit_amount: null,
      amount,
      source: "survey",
      appointment_id: s.apptId,
      lead_id: s.leadId,
    });
  }

  const seenPhone = new Set<string>();
  for (const q of [...phoneQuotes].sort(byDay)) {
    if (seenPhone.has(q.leadId)) continue;
    seenPhone.add(q.leadId);
    const amount = round2(Math.max(0, fees.phoneQuoteFee));
    if (amount <= 0) continue;
    out.push({
      description: `Telephone quote — ${q.customer}${q.ref ? ` (${q.ref})` : ""}`,
      work_date: day10(q.day) || null,
      quantity: null,
      unit_amount: null,
      amount,
      source: "phone_quote",
      appointment_id: null,
      lead_id: q.leadId,
    });
  }

  const seenJob = new Set<string>();
  for (const c of [...completions].sort(byDay)) {
    if (seenJob.has(c.leadId)) continue;
    seenJob.add(c.leadId);
    const amount = commissionAmount(c.value, c.vatEnabled, fees.commissionPct);
    if (amount <= 0) continue;
    const exVat = jobValueExVat(c.value, c.vatEnabled);
    out.push({
      description: `Commission ${pctLabel(fees.commissionPct)}% of ${gbp(exVat)} — ${c.customer}${c.ref ? ` (${c.ref})` : ""}`,
      work_date: day10(c.day) || null,
      quantity: null,
      unit_amount: null,
      amount,
      source: "commission",
      appointment_id: null,
      lead_id: c.leadId,
    });
  }

  return out;
}
