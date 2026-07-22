/**
 * Storage report — the Performance "Storage" tab's numbers (iMVE Storage
 * Analysis clone-and-improve, docs/imve-discovery.md §5). Pure and testable.
 *
 * Revenue here is computed FROM AGREED LET RATES, not from invoices — storage
 * invoicing stays manual in Zoho until billing phase 2, so "earned to date" is
 * an estimate of what should have been billed, and "recurring" is the run-rate
 * of everything currently let. The UI says so on the cards.
 *
 * buildStorageCostReport is the SUPPLIER side of the ledger (storage billing v2,
 * docs/storage-billing-v2-prd.md §6) — what Sandys should charge us this month.
 */

import type { StorageSupplierCosts } from "./storage-rates";

export interface ReportSite {
  id: string;
  is_active: boolean;
}

export interface ReportUnit {
  id: string;
  site_id: string;
  unit_type: string;
  is_active: boolean;
}

export interface ReportLet {
  id: string;
  unit_id: string;
  client_id: string;
  start_date: string;
  end_date: string | null;
  rate: number | null;
  rate_period: string; // week | month
}

export interface StorageReport {
  sites: number;
  units: { total: number; occupied: number; available: number; occupancyPct: number | null };
  byType: { type: string; total: number; occupied: number }[];
  customers: { current: number; former: number };
  /** Run-rate of all open lets, normalised both ways (month = week × 52/12). */
  recurring: { perWeek: number; perMonth: number; pricedLets: number; unpricedLets: number };
  avgWeeklyRate: number | null;
  /** Estimate of what the let history should have billed up to today. */
  earnedToDate: number;
  /** Completed-let length + the longest let still running, in whole weeks. */
  avgLetWeeks: number | null;
  longestOpenWeeks: number | null;
}

export interface ReportInvoice {
  amount: number;
  status: string; // pending | sent | paid | void | error
  period_start: string;
}

export interface StorageBillingStats {
  /** Live invoicing totals (void/error excluded from billed). */
  billed: number;
  paid: number;
  outstanding: number;
  invoiceCount: number;
  paidCount: number;
  outstandingCount: number;
  /** Sent invoices whose PERIOD already started 14+ days ago — chase these. */
  overdueCount: number;
}

/** Real invoicing analytics (phase 2) — replaces the earned-to-date estimate
 *  as the number to trust once billing runs. */
export function buildStorageBillingStats(invoices: ReportInvoice[], todayIso: string): StorageBillingStats {
  let billed = 0,
    paid = 0,
    outstanding = 0,
    paidCount = 0,
    outstandingCount = 0,
    overdueCount = 0;
  const overdueBefore = new Date(`${todayIso.slice(0, 10)}T00:00:00Z`);
  overdueBefore.setUTCDate(overdueBefore.getUTCDate() - 14);
  const overdueCut = overdueBefore.toISOString().slice(0, 10);

  let counted = 0;
  for (const inv of invoices) {
    if (inv.status === "void" || inv.status === "error") continue;
    counted++;
    const amt = Number(inv.amount) || 0;
    billed += amt;
    if (inv.status === "paid") {
      paid += amt;
      paidCount++;
    } else {
      outstanding += amt;
      outstandingCount++;
      if (inv.period_start.slice(0, 10) <= overdueCut) overdueCount++;
    }
  }
  const r = (n: number) => Math.round(n * 100) / 100;
  return {
    billed: r(billed),
    paid: r(paid),
    outstanding: r(outstanding),
    invoiceCount: counted,
    paidCount,
    outstandingCount,
    overdueCount,
  };
}

const WEEK_MS = 7 * 86_400_000;
const dayMs = (d: string): number => new Date(`${d}T00:00:00Z`).getTime();

/** Whole weeks between two yyyy-mm-dd days, minimum 1 — a let occupies its
 *  first week from day one (storage bills ahead, not behind). */
export function letWeeks(start: string, endOrToday: string): number {
  const span = dayMs(endOrToday) - dayMs(start);
  if (Number.isNaN(span) || span < 0) return 1;
  return Math.max(1, Math.ceil(span / WEEK_MS));
}

/** A let's rate normalised to £/week (month → × 12/52). */
export function weeklyRate(l: { rate: number | null; rate_period: string }): number | null {
  if (l.rate == null) return null;
  const r = Number(l.rate);
  return l.rate_period === "month" ? (r * 12) / 52 : r;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function buildStorageReport(
  sites: ReportSite[],
  units: ReportUnit[],
  lets: ReportLet[],
  today: string,
): StorageReport {
  const open = lets.filter((l) => l.end_date == null);
  const ended = lets.filter((l) => l.end_date != null);
  const occupiedIds = new Set(open.map((l) => l.unit_id));

  const activeUnits = units.filter((u) => u.is_active);
  const occupied = activeUnits.filter((u) => occupiedIds.has(u.id)).length;
  const total = activeUnits.length;

  /* by type — active units only */
  const typeAgg = new Map<string, { total: number; occupied: number }>();
  for (const u of activeUnits) {
    const cur = typeAgg.get(u.unit_type) ?? { total: 0, occupied: 0 };
    cur.total++;
    if (occupiedIds.has(u.id)) cur.occupied++;
    typeAgg.set(u.unit_type, cur);
  }
  const byType = [...typeAgg.entries()]
    .map(([type, v]) => ({ type, ...v }))
    .sort((a, b) => b.total - a.total);

  /* customers: current = has an open let; former = only ended lets */
  const currentClients = new Set(open.map((l) => l.client_id));
  const formerClients = new Set(ended.map((l) => l.client_id).filter((c) => !currentClients.has(c)));

  /* recurring run-rate from open lets */
  let perWeek = 0;
  let pricedLets = 0;
  for (const l of open) {
    const w = weeklyRate(l);
    if (w == null) continue;
    perWeek += w;
    pricedLets++;
  }
  const recurring = {
    perWeek: round2(perWeek),
    perMonth: round2((perWeek * 52) / 12),
    pricedLets,
    unpricedLets: open.length - pricedLets,
  };
  const avgWeeklyRate = pricedLets ? round2(perWeek / pricedLets) : null;

  /* earned to date — every let, weeks elapsed × weekly rate */
  let earned = 0;
  for (const l of lets) {
    const w = weeklyRate(l);
    if (w == null) continue;
    earned += letWeeks(l.start_date, l.end_date ?? today) * w;
  }

  /* durations */
  const endedWeeks = ended.map((l) => letWeeks(l.start_date, l.end_date!));
  const avgLetWeeks = endedWeeks.length
    ? Math.round(endedWeeks.reduce((s, n) => s + n, 0) / endedWeeks.length)
    : null;
  const openWeeks = open.map((l) => letWeeks(l.start_date, today));
  const longestOpenWeeks = openWeeks.length ? Math.max(...openWeeks) : null;

  return {
    sites: sites.filter((s) => s.is_active).length,
    units: {
      total,
      occupied,
      available: total - occupied,
      occupancyPct: total ? Math.round((occupied / total) * 100) : null,
    },
    byType,
    customers: { current: currentClients.size, former: formerClients.size },
    recurring,
    avgWeeklyRate,
    earnedToDate: round2(earned),
    avgLetWeeks,
    longestOpenWeeks,
  };
}

/* ----------------------------------------------------- supplier cost (§6) */

export interface CostReportLet extends ReportLet {
  /** 'period' | 'crate_daily' — only crate_daily lets accrue per-day costs. */
  billing_model?: string | null;
}

export interface StorageCostReport {
  /** containersCount × containerMonthCost — accrues regardless of occupancy. */
  containersFixedCost: number;
  /** Inclusive days crate lets were stored inside the month window. */
  crateDays: number;
  crateDaysCost: number;
  /** Handling events (in/out/access) dated inside the month window. */
  handlingEvents: number;
  handlingCost: number;
  totalCost: number;
  /** Occupied ÷ total ACTIVE container units; null when none exist. */
  containerUtilisationPct: number | null;
}

const DAY_MS = 86_400_000;

/** Inclusive whole days [start, end] overlaps [winFrom, winTo] (0 when disjoint). */
function overlapDaysInclusive(start: string, end: string, winFrom: string, winTo: string): number {
  const from = Math.max(dayMs(start), dayMs(winFrom));
  const to = Math.min(dayMs(end), dayMs(winTo));
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return 0;
  return Math.round((to - from) / DAY_MS) + 1;
}

/**
 * "Supplier cost — this month": what Sandys should bill us for the window.
 * Container rent is fixed (utilisation is the metric, not the cost driver);
 * crate days accrue only while goods are actually stored, so the CALLER passes
 * `monthEndIso` as the accrual cut-off — today for the current month, the last
 * calendar day for a closed month. Handling costs use the CURRENT supplier
 * rate: `storage_handling_events.amount` is the customer charge, not the cost.
 */
export function buildStorageCostReport(input: {
  lets: CostReportLet[];
  events: { event_date: string }[];
  units: ReportUnit[];
  supplier: StorageSupplierCosts;
  /** First day of the month, yyyy-mm-dd. */
  monthStartIso: string;
  /** Inclusive accrual cut-off, yyyy-mm-dd (today for the current month). */
  monthEndIso: string;
}): StorageCostReport {
  const { lets, events, units, supplier, monthStartIso, monthEndIso } = input;

  const containersFixedCost = round2(supplier.containersCount * supplier.containerMonthCost);

  let crateDays = 0;
  for (const l of lets) {
    if (l.billing_model !== "crate_daily") continue;
    crateDays += overlapDaysInclusive(l.start_date, l.end_date ?? monthEndIso, monthStartIso, monthEndIso);
  }
  const crateDaysCost = round2(crateDays * supplier.crateDayCost);

  let handlingEvents = 0;
  for (const e of events) {
    const d = e.event_date.slice(0, 10);
    if (d >= monthStartIso && d <= monthEndIso) handlingEvents++;
  }
  const handlingCost = round2(handlingEvents * supplier.handlingEventCost);

  // Utilisation of the fixed-cost containers — occupied now, of active units.
  const openUnitIds = new Set(lets.filter((l) => l.end_date == null).map((l) => l.unit_id));
  const containers = units.filter((u) => u.is_active && u.unit_type.startsWith("container_"));
  const occupiedContainers = containers.filter((u) => openUnitIds.has(u.id)).length;

  return {
    containersFixedCost,
    crateDays,
    crateDaysCost,
    handlingEvents,
    handlingCost,
    totalCost: round2(containersFixedCost + crateDaysCost + handlingCost),
    containerUtilisationPct: containers.length
      ? Math.round((occupiedContainers / containers.length) * 100)
      : null,
  };
}
