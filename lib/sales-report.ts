/**
 * Sales report — the Performance "Sales" tab's numbers (iMVE Reports clone-and-
 * improve, docs/imve-discovery.md §5). Pure and testable: every comparison is on
 * UK calendar days, and each KPI carries the definition the UI prints under the
 * number (the iMVE pattern worth stealing — nobody argues about what a card
 * means when the card says it).
 *
 * The four revenue lenses:
 *  - generated  = value of booked jobs MOVING in the period
 *  - paid       = money actually received in the period (deposits + commitments + balances)
 *  - projected  = value of quotes WON in the period
 *  - potential  = value of all quotes SENT in the period (one per lead)
 */

import { classifySource, SOURCES, type SourceKey } from "@/lib/dashboard/compute";

export interface SalesQuote {
  id: string;
  lead_id: string | null;
  status: string; // draft | sent | accepted | rejected | superseded
  grand_total: number | null;
  agreed_price: number | null;
  created_at: string | null;
  email_sent_at: string | null;
  accepted_at: string | null;
  moving_date: string | null;
  deposit_amount: number | null;
  deposit_paid_at: string | null;
  /** Payments Policy v2 made the commitment (25% of gross, less the deposit) a
   *  real THIRD payment. /payments counts it; this report did not. */
  commitment_invoice_amount?: number | null;
  commitment_paid_at?: string | null;
  /** Stamped when a booking is cancelled. The quote deliberately STAYS
   *  status='accepted' (the unwind only stamps this), so every "is this won"
   *  test must read it or refunded jobs count as revenue. */
  booking_cancelled_at?: string | null;
}

export interface SalesLead {
  id: string;
  status: string;
  submitted_at: string | null;
  created_at: string | null;
  preferred_date: string | null;
  balance_amount: number | null;
  balance_paid_at: string | null;
  entry_channel: string;
  gclid: string | null;
  gbraid: string | null;
  wbraid: string | null;
  fbclid: string | null;
  utm_source: string | null;
  utm_medium: string | null;
}

/** Completed survey appointment (lead_id + when it happened). */
export interface SalesSurvey {
  lead_id: string | null;
  starts_at: string | null;
}

export interface Money {
  total: number;
  count: number;
}

export interface SalesReport {
  generated: Money;
  paid: Money;
  projected: Money;
  potential: Money;
  jobsCompleted: number;
  enquiries: number;
  won: number;
  conversionPct: number | null;
  avgJobValue: number | null;
  sameDay: { same: number; of: number; pct: number | null };
  funnel: { sent: number; accepted: number; declined: number; awaiting: number; lost: number; pct: number | null };
  bySource: { key: SourceKey; label: string; color: string; enquiries: number; won: number; value: number }[];
  statusCounts: { status: string; count: number }[];
}

const UK = "Europe/London";

/** Timestamp → UK calendar day; date strings pass through. */
export function ukDayOf(ts: string | null | undefined): string | null {
  if (!ts) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(ts)) return ts;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString("en-CA", { timeZone: UK });
}

const val = (q: SalesQuote): number => Number(q.agreed_price ?? q.grand_total ?? 0);

/** When a quote counts as "sent" (email stamp, else its creation once past draft). */
export function quoteSentDay(q: SalesQuote): string | null {
  if (q.status === "draft") return null;
  return ukDayOf(q.email_sent_at ?? q.created_at);
}

/** One quote per lead: prefer the accepted one, else the latest sent (superseded excluded). */
export function dedupePerLead(quotes: SalesQuote[]): SalesQuote[] {
  const byLead = new Map<string, SalesQuote>();
  const orphans: SalesQuote[] = [];
  for (const q of quotes) {
    if (q.status === "superseded" || q.status === "draft") continue;
    if (!q.lead_id) {
      orphans.push(q);
      continue;
    }
    const cur = byLead.get(q.lead_id);
    if (!cur) {
      byLead.set(q.lead_id, q);
      continue;
    }
    const better =
      (q.status === "accepted" && cur.status !== "accepted") ||
      (q.status === "accepted") === (cur.status === "accepted") &&
        (q.created_at ?? "") > (cur.created_at ?? "");
    if (better) byLead.set(q.lead_id, q);
  }
  return [...byLead.values(), ...orphans];
}

/** fromDay/toDay are inclusive UK calendar days ("2026-07-01".."2026-07-31"). */
export function buildSalesReport(
  quotes: SalesQuote[],
  leads: SalesLead[],
  surveys: SalesSurvey[],
  fromDay: string,
  toDay: string,
): SalesReport {
  const inRange = (day: string | null): boolean => day != null && day >= fromDay && day <= toDay;
  const leadById = new Map(leads.map((l) => [l.id, l]));
  const live = quotes.filter((q) => q.status !== "superseded" && q.status !== "draft");
  // A cancelled booking keeps status='accepted', so without this filter a
  // refunded job counted in "Revenue generated"/"projected" AND appeared under
  // declined in the same status breakdown — inflating revenue and conversion at
  // once. lib/dashboard/compute.isWonQuote already excludes it; this is the
  // surface that skipped the rule.
  const accepted = live.filter((q) => q.status === "accepted" && !q.booking_cancelled_at);

  const moveDay = (q: SalesQuote): string | null =>
    ukDayOf(q.moving_date) ?? ukDayOf(q.lead_id ? leadById.get(q.lead_id)?.preferred_date : null);

  /* revenue lenses */
  const generatedQs = accepted.filter((q) => inRange(moveDay(q)));
  const generated: Money = { total: generatedQs.reduce((s, q) => s + val(q), 0), count: generatedQs.length };

  let paidTotal = 0;
  let paidCount = 0;
  // Iterate `live` (superseded + draft excluded), not the raw quotes: a re-quote
  // carries the paid deposit's stamp onto the new accepted quote but LEAVES it on
  // the now-superseded old row (supersedeSiblingQuotes), so one real deposit lives
  // on two rows. Counting only live rows credits the carried deposit exactly once.
  for (const q of live) {
    // The commitment is a real payment that lands between deposit and balance.
    // Omitting it made "Money paid" under-report every confirmed job by 25%
    // minus the deposit until the balance arrived, so this card and /payments
    // could never reconcile — while the card's own caption promised "money
    // actually received in the period".
    if (inRange(ukDayOf(q.commitment_paid_at ?? null)) && q.commitment_invoice_amount) {
      paidTotal += Number(q.commitment_invoice_amount);
      paidCount++;
    }
    if (inRange(ukDayOf(q.deposit_paid_at)) && q.deposit_amount) {
      paidTotal += Number(q.deposit_amount);
      paidCount++;
    }
  }
  for (const l of leads) {
    if (inRange(ukDayOf(l.balance_paid_at)) && l.balance_amount) {
      paidTotal += Number(l.balance_amount);
      paidCount++;
    }
  }
  const paid: Money = { total: paidTotal, count: paidCount };

  const projectedQs = accepted.filter((q) => inRange(ukDayOf(q.accepted_at)));
  const projected: Money = { total: projectedQs.reduce((s, q) => s + val(q), 0), count: projectedQs.length };

  const deduped = dedupePerLead(quotes);
  const sentInRange = deduped.filter((q) => inRange(quoteSentDay(q)));
  const potential: Money = {
    total: sentInRange.reduce((s, q) => s + Number(q.grand_total ?? 0), 0),
    count: sentInRange.length,
  };

  const jobsCompleted = generatedQs.filter(
    (q) => q.lead_id && leadById.get(q.lead_id)?.status === "completed",
  ).length;

  /* enquiries + conversion (won so far, any time) */
  const enquiryDay = (l: SalesLead) => ukDayOf(l.submitted_at ?? l.created_at);
  const rangeLeads = leads.filter((l) => inRange(enquiryDay(l)));
  const acceptedLeadIds = new Set(accepted.map((q) => q.lead_id).filter(Boolean) as string[]);
  const isWon = (l: SalesLead) => acceptedLeadIds.has(l.id) || l.status === "confirmed" || l.status === "completed";
  const won = rangeLeads.filter(isWon).length;
  const conversionPct = rangeLeads.length ? Math.round((won / rangeLeads.length) * 100) : null;

  const avgJobValue = projected.count ? Math.round(projected.total / projected.count) : null;

  /* same-day quoting: surveyed in range AND quoted → % quoted the SAME UK day */
  const sentDaysByLead = new Map<string, string[]>();
  for (const q of live) {
    const d = quoteSentDay(q);
    if (!q.lead_id || !d) continue;
    const list = sentDaysByLead.get(q.lead_id) ?? [];
    list.push(d);
    sentDaysByLead.set(q.lead_id, list);
  }
  let sameDaySame = 0;
  let sameDayOf = 0;
  for (const s of surveys) {
    const day = ukDayOf(s.starts_at);
    if (!s.lead_id || !inRange(day)) continue;
    const sent = sentDaysByLead.get(s.lead_id);
    if (!sent?.length) continue;
    sameDayOf++;
    if (sent.some((d) => d === day)) sameDaySame++;
  }
  const sameDay = {
    same: sameDaySame,
    of: sameDayOf,
    pct: sameDayOf ? Math.round((sameDaySame / sameDayOf) * 100) : null,
  };

  /* quote funnel (one per lead, sent in range) */
  let fAccepted = 0;
  let fDeclined = 0;
  let fLost = 0;
  let fAwaiting = 0;
  for (const q of sentInRange) {
    const lead = q.lead_id ? leadById.get(q.lead_id) : null;
    if (q.status === "accepted") fAccepted++;
    else if (q.status === "rejected") fDeclined++;
    else if (lead?.status === "declined") fLost++;
    else fAwaiting++;
  }
  const funnel = {
    sent: sentInRange.length,
    accepted: fAccepted,
    declined: fDeclined,
    awaiting: fAwaiting,
    lost: fLost,
    pct: sentInRange.length ? Math.round((fAccepted / sentInRange.length) * 100) : null,
  };

  /* per-source: enquiries in range → won + value */
  const valueByLead = new Map<string, number>();
  for (const q of accepted) if (q.lead_id) valueByLead.set(q.lead_id, val(q));
  const srcAgg = new Map<SourceKey, { enquiries: number; won: number; value: number }>();
  for (const l of rangeLeads) {
    const key = classifySource(l);
    const cur = srcAgg.get(key) ?? { enquiries: 0, won: 0, value: 0 };
    cur.enquiries++;
    if (isWon(l)) {
      cur.won++;
      cur.value += valueByLead.get(l.id) ?? 0;
    }
    srcAgg.set(key, cur);
  }
  const bySource = SOURCES.filter((s) => srcAgg.has(s.key)).map((s) => ({
    key: s.key,
    label: s.label,
    color: s.color,
    ...srcAgg.get(s.key)!,
  }));

  /* current status of the period's enquiries */
  const statusAgg = new Map<string, number>();
  for (const l of rangeLeads) statusAgg.set(l.status, (statusAgg.get(l.status) ?? 0) + 1);
  const statusCounts = [...statusAgg.entries()]
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => b.count - a.count);

  return {
    generated,
    paid,
    projected,
    potential,
    jobsCompleted,
    enquiries: rangeLeads.length,
    won,
    conversionPct,
    avgJobValue,
    sameDay,
    funnel,
    bySource,
    statusCounts,
  };
}
