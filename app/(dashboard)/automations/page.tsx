import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { AutomationsLog } from "@/components/automations/automations-log";
import type { CronRunRow } from "@/lib/cron/jobs";

/**
 * /automations — the live log of every scheduled job (the cron audit trail).
 * Office-only via RLS on cron_runs. Server-renders the latest snapshot; the
 * client component then refreshes on open and every 30 minutes.
 */
export const dynamic = "force-dynamic";

export default async function AutomationsPage() {
  const sb = await createClient();
  const { data } = await sb
    .from("cron_runs")
    .select("id, job, status, started_at, finished_at, duration_ms, summary, error")
    .order("started_at", { ascending: false })
    .limit(100);

  return (
    <main className="flex-1 p-6 md:p-8">
      <PageHeader eyebrow="System" title="Automations">
        <p className="text-sm text-mist-400">Every scheduled job that has fired, and whether it&apos;s firing on cadence.</p>
      </PageHeader>
      <AutomationsLog initialRuns={(data ?? []) as CronRunRow[]} />
    </main>
  );
}
