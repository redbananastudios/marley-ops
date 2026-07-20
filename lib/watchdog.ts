import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { CRON_JOBS } from "@/lib/cron/jobs";
import { bankFeedConfigured } from "@/lib/bank-feed/sync";
import { sendSms } from "@/lib/comms/send";
import {
  alertsAlreadySent,
  feedStalenessAlert,
  findOverdueJobs,
  WATCHDOG_JOB,
  type HealthAlert,
} from "@/lib/watchdog-rules";
import {
  checkpointOperationalIssues,
  deliverDailyOperationalIssueDigest,
  reportOperationalIssue,
  resolveOperationalIssue,
} from "@/lib/ops/issues";

/**
 * Health watchdog (cron, every 15 min): checks that every registered
 * automation has a fresh successful run, and that the bank feed is actually
 * seeing transactions — then SMSes Peter (OPS_ALERT_SMS via WebEx) when
 * something is wrong. A 6-hour cooldown per alert set stops a broken job
 * paging every 15 minutes all night. Decision rules live in
 * lib/watchdog-rules.ts (pure + tested).
 *
 * HONEST LIMIT: this runs INSIDE the app — if the whole box or container is
 * down, no SMS can leave it. Total-outage alerting needs the external uptime
 * monitor on /api/version (go-live checklist B4). This watchdog covers the
 * quieter failure class: a cron silently stopping, Zoho/Sheets creds expiring,
 * the feed going stale while the app looks healthy.
 */

export type WatchdogSummary = {
  alerts: HealthAlert[];
  smsSent: boolean;
  smsError?: string;
  smsSkipped?: "cooldown" | "no-recipient" | "none";
  dailyIssueUpdates?: number;
  dailyIssueDigest?: "sent" | "simulated" | "already-sent" | "none" | "failed";
};

const COOLDOWN_HOURS = 6;

export async function runHealthWatchdog(
  sb: SupabaseClient<Database>,
  opts?: { forceTestSms?: boolean },
): Promise<WatchdogSummary> {
  const now = new Date();

  if (opts?.forceTestSms) {
    const to = process.env.OPS_ALERT_SMS;
    if (!to) return { alerts: [], smsSent: false, smsSkipped: "no-recipient" };
    const res = await sendSms({
      to,
      body: "Marley Ops watchdog test: SMS alerting is wired up. You'll only hear from me when an automation goes quiet or the bank feed stalls.",
    });
    return { alerts: [], smsSent: res.ok, ...(res.ok ? {} : { smsError: res.error }) };
  }

  // Newest successful run per registered job (per-job head queries — an
  // aggregate over cron_runs isn't expressible via PostgREST, and the 2-min
  // jobs would swamp any single recent-rows window).
  const latestOk: Record<string, string | undefined> = {};
  await Promise.all(
    CRON_JOBS.filter((j) => j.slug !== WATCHDOG_JOB).map(async (j) => {
      const { data } = await sb
        .from("cron_runs")
        .select("finished_at")
        .eq("job", j.slug)
        .eq("status", "ok")
        .order("finished_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      latestOk[j.slug] = (data?.finished_at as string | undefined) ?? undefined;
    }),
  );

  const alerts = findOverdueJobs(latestOk, now);

  if (bankFeedConfigured()) {
    const { data: newest } = await sb
      .from("bank_transactions")
      .select("created_at")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const stale = feedStalenessAlert((newest?.created_at as string | null) ?? null, true, now);
    if (stale) alerts.push(stale);
  }

  const activeAlertKeys = new Set(alerts.map((alert) => alert.key));
  const { data: existingWatchdogIssues } = await sb
    .from("operational_issues")
    .select("issue_key")
    .eq("source", "health-watchdog")
    .eq("status", "open");
  const existingKeys = new Set((existingWatchdogIssues ?? []).map((issue) => issue.issue_key.replace(/^watchdog:/, "")));
  await Promise.all([
    ...alerts.filter((alert) => !existingKeys.has(alert.key)).map((alert) =>
      reportOperationalIssue(sb, {
        key: `watchdog:${alert.key}`,
        severity: "error",
        source: "health-watchdog",
        event: "watchdog.health_alert",
        message: alert.message,
        context: { alertKey: alert.key },
      }),
    ),
    ...[...existingKeys]
      .filter((key) => !activeAlertKeys.has(key))
      .map((key) => resolveOperationalIssue(sb, `watchdog:${key}`)),
  ]);
  const dailyIssueUpdates = await checkpointOperationalIssues(sb, now);
  const dailyIssueDigest = await deliverDailyOperationalIssueDigest(sb, now);

  if (!alerts.length) return { alerts, smsSent: false, smsSkipped: "none", dailyIssueUpdates, dailyIssueDigest };

  // Cooldown: what did we already SMS in the last 6h?
  const since = new Date(now.getTime() - COOLDOWN_HOURS * 3_600_000).toISOString();
  const { data: recent } = await sb
    .from("cron_runs")
    .select("summary")
    .eq("job", WATCHDOG_JOB)
    .gte("finished_at", since)
    .order("finished_at", { ascending: false })
    .limit(48);
  const summaries = (recent ?? []).map((r) => (r.summary ?? {}) as unknown as WatchdogSummary);
  if (alertsAlreadySent(alerts, summaries)) {
    return { alerts, smsSent: false, smsSkipped: "cooldown", dailyIssueUpdates, dailyIssueDigest };
  }

  const to = process.env.OPS_ALERT_SMS;
  if (!to) return { alerts, smsSent: false, smsSkipped: "no-recipient", dailyIssueUpdates, dailyIssueDigest };

  const body = `MARLEY OPS ALERT: ${alerts
    .map((a) => a.message)
    .join("; ")
    .slice(0, 380)} — ops.marleymoves.co.uk/automations`;
  const res = await sendSms({ to, body });
  return { alerts, smsSent: res.ok, dailyIssueUpdates, dailyIssueDigest, ...(res.ok ? {} : { smsError: res.error }) };
}
