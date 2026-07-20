import { createAdminClient } from "@/lib/supabase/admin";
import { log, errorContext } from "@/lib/log";

/**
 * Wrap a cron job's work so every run is (a) structured-logged and (b) recorded
 * in public.cron_runs for the /automations page. The job's `work` returns its
 * own summary object (whatever shape it likes); a throw is caught, logged, and
 * stored as an error run — the job never silently vanishes.
 *
 *   export async function GET(req: Request) {
 *     if (!(await requireUserOrCronSecret(req))) return unauthorised;
 *     const { ok, summary, error, status } = await runCron("chase", async () => {
 *       ... return summaryObject
 *     });
 *     return NextResponse.json({ ok, ...(summary ?? {}), ...(error ? { error } : {}) },
 *       { status });
 *   }
 *
 * Persistence is best-effort: if the audit insert fails we still return the real
 * result (a broken log table must never break the automation itself).
 */
export interface CronResult<T> {
  ok: boolean;
  status: number; // 200 on success, 500 on failure — for the route response
  summary: T | null;
  error?: string;
}

export async function runCron<T extends Record<string, unknown>>(
  job: string,
  work: () => Promise<T>,
): Promise<CronResult<T>> {
  const startedAt = new Date();
  log.info("cron.start", { job, startedAt: startedAt.toISOString() });

  let summary: T | null = null;
  let ok = true;
  let error: string | undefined;
  let stack: string | undefined;

  try {
    summary = await work();
    // Several integrations deliberately return structured failures instead of
    // throwing. Treat `{ ok: false }` as a failed run so watchdogs, HTTP status
    // and the audit log cannot report a false green.
    if (summary.ok === false) {
      ok = false;
      error = typeof summary.error === "string" ? summary.error : "Job reported failure";
    }
  } catch (e) {
    ok = false;
    const ec = errorContext(e);
    error = ec.error;
    stack = ec.stack;
  }

  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - startedAt.getTime();

  if (ok) log.info("cron.done", { job, durationMs, summary });
  else log.error("cron.failed", { job, durationMs, error, stack });

  // Best-effort audit row — never let a logging failure surface to the caller.
  try {
    const sb = createAdminClient();
    const { error: insertErr } = await sb.from("cron_runs").insert({
      job,
      status: ok ? "ok" : "error",
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_ms: durationMs,
      summary: (summary ?? {}) as Record<string, unknown>,
      error: error ?? null,
    } as never);
    if (insertErr) log.warn("cron.audit.insert_failed", { job, error: insertErr.message });
  } catch (e) {
    log.warn("cron.audit.insert_threw", { job, ...errorContext(e) });
  }

  return { ok, status: ok ? 200 : 500, summary, error };
}
