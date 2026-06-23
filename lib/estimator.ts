/**
 * Estimator pay + performance — shared aggregation for the dashboard panel and the
 * Performance/payroll page. A "visit" is a completed (attended) survey appointment
 * assigned to an estimator; that's the billable unit. Luke is paid ESTIMATOR_FEE
 * per attended visit; a visit counts as won when its lead became a job.
 *
 * ESTIMATOR_FEE is a constant for now — it moves into the Settings/rates screen
 * later (editable default + per-appointment override), alongside the other job costs.
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

/** Group attended visits into per-estimator stats, sorted by visits desc. */
export function aggregateEstimators(visits: EstimatorVisit[]): EstimatorStat[] {
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
    s.fee = s.visits * ESTIMATOR_FEE;
  }
  return out.sort((a, b) => b.visits - a.visits);
}
