/**
 * Estimator pay + performance — shared aggregation for the dashboard panel and the
 * Performance/payroll page. A "visit" is a completed (attended) survey appointment
 * assigned to an estimator; that's the billable unit. Luke is paid ESTIMATOR_FEE
 * per attended visit; a visit counts as won when its lead became a job.
 *
 * The fee is editable in Settings (business_settings.estimator_fee); pass it into
 * aggregateEstimators. ESTIMATOR_FEE is the fallback default only.
 */

export const ESTIMATOR_FEE = 50;

export interface EstimatorVisit {
  apptId: string;
  estimatorId: string;
  estimatorName: string;
  leadId: string | null;
  customer: string;
  date: string | null;
  won: boolean;
  value: number | null;
  /** Brand slug (appointments.brand, stamped from the lead) — the carrier for
   *  the optional per-brand slice (multi-brand PRD §4 /performance). */
  brand?: string | null;
}

export interface EstimatorStat {
  id: string;
  name: string;
  visits: number;
  won: number;
  winRate: number;
  wonValue: number;
  fee: number;
}

/** Group attended visits into per-estimator stats, sorted by visits desc.
 *  `fee` is the per-visit rate from Settings (defaults to ESTIMATOR_FEE).
 *
 *  `brand`: undefined or `'all'` narrows nothing (byte-identical to today); a
 *  named slug counts only that brand's visits, so combined visits/fees equal
 *  the sum of the per-brand slices. The stats stay per-PERSON either way —
 *  estimators work both brands, so a row is an estimator, never a brand. */
export function aggregateEstimators(
  visits: EstimatorVisit[],
  fee: number = ESTIMATOR_FEE,
  brand?: string,
): EstimatorStat[] {
  if (brand && brand !== "all") visits = visits.filter((v) => v.brand === brand);
  const by = new Map<string, EstimatorStat>();
  for (const v of visits) {
    const cur =
      by.get(v.estimatorId) ??
      { id: v.estimatorId, name: v.estimatorName, visits: 0, won: 0, winRate: 0, wonValue: 0, fee: 0 };
    cur.visits += 1;
    if (v.won) {
      cur.won += 1;
      cur.wonValue += v.value ?? 0;
    }
    by.set(v.estimatorId, cur);
  }
  const out = [...by.values()];
  for (const s of out) {
    s.winRate = s.visits ? Math.round((s.won / s.visits) * 100) : 0;
    s.fee = s.visits * fee;
  }
  return out.sort((a, b) => b.visits - a.visits);
}
