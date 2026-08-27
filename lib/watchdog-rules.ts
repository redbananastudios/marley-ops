import { CRON_JOBS } from "@/lib/cron/jobs";

/**
 * Health-watchdog decision rules (pure, no I/O — unit-tested). The orchestrator
 * in lib/watchdog.ts feeds these from cron_runs + bank_transactions and SMSes
 * when they say something is wrong.
 */

export interface HealthAlert {
  /** Stable key for cooldown comparison (e.g. "overdue:chase"). */
  key: string;
  message: string;
}

export const WATCHDOG_JOB = "health-watchdog";

/** Jobs whose newest SUCCESSFUL run is older than their registered freshness
 *  window (never-run jobs alert too — a registered automation that has never
 *  fired IS the failure mode this exists to catch). */
export function findOverdueJobs(
  latestOkByJob: Record<string, string | undefined>,
  now: Date,
): HealthAlert[] {
  const alerts: HealthAlert[] = [];
  for (const job of CRON_JOBS) {
    if (job.slug === WATCHDOG_JOB) continue;
    const lastOk = latestOkByJob[job.slug];
    if (!lastOk) {
      alerts.push({ key: `never:${job.slug}`, message: `${job.label} has never run` });
      continue;
    }
    const ageMins = (now.getTime() - new Date(lastOk).getTime()) / 60000;
    if (ageMins > job.maxAgeMins) {
      const ageLabel = ageMins >= 120 ? `${Math.round(ageMins / 60)}h` : `${Math.round(ageMins)}m`;
      alerts.push({ key: `overdue:${job.slug}`, message: `${job.label} last ok ${ageLabel} ago` });
    }
  }
  return alerts;
}

/** The bank feed syncing OK but seeing NOTHING is its own failure mode (Monzo
 *  silently stopping the export writes). An active removals business banks
 *  most days; 72h of silence is worth a human glance. */
export function feedStalenessAlert(
  newestTxCreatedAt: string | null,
  configured: boolean,
  now: Date,
): HealthAlert | null {
  if (!configured || !newestTxCreatedAt) return null;
  const ageHours = (now.getTime() - new Date(newestTxCreatedAt).getTime()) / 3_600_000;
  if (ageHours <= 72) return null;
  return {
    key: "feed-stale",
    message: `Bank feed has ingested nothing for ${Math.round(ageHours)}h — check the Monzo export`,
  };
}

/** Zoho refusing us outright — a deactivated org user, a revoked grant, missing
 *  credentials. Only the PERMANENT class alerts: a timeout or a 5xx clears on
 *  the next pass and must not page anyone at 3am, whereas a lock-out silently
 *  stops every invoice and every payment check until a human acts. On
 *  2026-08-27 that state ran for hours with `alerts: []` on every pass, because
 *  this watchdog only ever asked whether the CRONS were running — and they
 *  were, faithfully reporting nothing-to-do. */
export function zohoAccessAlert(check: { ok: boolean; accessDenied?: boolean }): HealthAlert | null {
  if (check.ok || !check.accessDenied) return null;
  return {
    key: "zoho-access",
    message: "Zoho is refusing the ops integration — no invoices are being raised. Re-enable the ops user in Zoho",
  };
}

/** True when every current alert was already SMS'd inside the cooldown window
 *  (an alert set that GREW re-alerts immediately — new problems page). */
export function alertsAlreadySent(
  alerts: HealthAlert[],
  recentSentSummaries: { alerts?: { key: string }[]; smsSent?: boolean }[],
): boolean {
  if (!alerts.length) return true;
  const sent = new Set(
    recentSentSummaries
      .filter((s) => s.smsSent)
      .flatMap((s) => (s.alerts ?? []).map((a) => a.key)),
  );
  return alerts.every((a) => sent.has(a.key));
}
