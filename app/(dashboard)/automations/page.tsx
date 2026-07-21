import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { AutomationsLog } from "@/components/automations/automations-log";
import type { CronRunRow } from "@/lib/cron/jobs";
import { recentSendFailures } from "@/lib/crew-sheet/delivery-log";
import type { OperationalIssueRow } from "@/lib/ops/issues";

const fmtWhen = (iso: string): string =>
  new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/London",
  });
const fmtDate = (d: string): string =>
  d ? new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }) : "—";

/**
 * /automations — the live log of every scheduled job (the cron audit trail).
 * Office-only via RLS on cron_runs. Server-renders the latest snapshot; the
 * client component then refreshes on open and every 30 minutes.
 */
export const dynamic = "force-dynamic";

export default async function AutomationsPage() {
  const sb = await createClient();
  const [{ data }, { data: issues }, sheetFailures] = await Promise.all([
    sb
      .from("cron_runs")
      .select("id, job, status, started_at, finished_at, duration_ms, summary, error")
      .order("started_at", { ascending: false })
      .limit(100),
    sb
      .from("operational_issues")
      .select("id,issue_key,severity,source,event,message,status,occurrence_count,first_seen_at,last_seen_at,last_checkpoint_at,resolved_at")
      .eq("status", "open")
      .order("last_seen_at", { ascending: false })
      .limit(100),
    recentSendFailures(sb).catch(() => []),
  ]);

  return (
    <main className="flex-1 p-6 md:p-8">
      <PageHeader eyebrow="System" title="Automations">
        <p className="text-sm text-mist-400">Every scheduled job that has fired, and whether it&apos;s firing on cadence.</p>
      </PageHeader>

      {sheetFailures.length > 0 ? (
        <div className="mb-6 rounded-lg border border-danger/30 bg-danger/5 p-4">
          <p className="text-sm font-semibold text-danger">
            Crew job sheets that didn&apos;t send ({sheetFailures.length})
          </p>
          <p className="mt-0.5 text-xs text-mist-400">
            Last 48 hours. Check the crew member&apos;s email/phone on file, then re-run the job or send their sheet by hand.
          </p>
          <ul className="mt-3 space-y-1.5">
            {sheetFailures.map((f, i) => (
              <li key={i} className="flex flex-wrap items-baseline gap-x-2 text-sm text-ink">
                <span className="font-semibold">{f.staff}</span>
                <span className="text-mist-400">· {fmtDate(f.workDate)}</span>
                <span className="rounded bg-danger/10 px-1.5 py-0.5 text-[11px] font-medium uppercase text-danger">{f.channel}</span>
                <span className="text-xs text-mist-500">{f.error}</span>
                <span className="ml-auto text-xs text-mist-400">{fmtWhen(f.at)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <AutomationsLog
        initialRuns={(data ?? []) as CronRunRow[]}
        initialIssues={(issues ?? []) as OperationalIssueRow[]}
      />
    </main>
  );
}
