"use client";

/**
 * The automation log. Server-renders with the latest runs, then refreshes on
 * mount and every 30 minutes (Peter's spec) by polling /api/automations/runs.
 * Two views: a per-job health grid (is every automation firing on cadence?)
 * and a chronological log of recent runs.
 */

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock, Loader2, RefreshCw } from "lucide-react";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";
import { CRON_JOBS, type CronRunRow } from "@/lib/cron/jobs";

const POLL_MS = 30 * 60 * 1000; // 30 minutes
const LABEL_BY_SLUG = new Map(CRON_JOBS.map((j) => [j.slug, j.label]));

function relative(iso: string, now: number): string {
  const mins = Math.round((now - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtDuration(ms: number | null): string {
  if (ms == null) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Flatten the top-level scalar fields of a run summary into "key value" chips. */
function summaryPairs(summary: Record<string, unknown> | null): string[] {
  if (!summary) return [];
  return Object.entries(summary)
    .filter(([, v]) => typeof v === "number" || typeof v === "string" || typeof v === "boolean")
    .filter(([, v]) => v !== 0 && v !== "" && v !== false)
    .map(([k, v]) => `${k}: ${v}`);
}

function StatusChip({ status }: { status: CronRunRow["status"] }) {
  const meta =
    status === "ok"
      ? { cls: "bg-success-bg text-success", label: "OK", Icon: CheckCircle2 }
      : status === "error"
        ? { cls: "bg-danger-bg text-danger", label: "Error", Icon: AlertTriangle }
        : { cls: "bg-muted text-mist-500", label: "Skipped", Icon: Clock };
  const Icon = meta.Icon;
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-[11px] font-semibold", meta.cls)}>
      <Icon className="size-3" strokeWidth={2} /> {meta.label}
    </span>
  );
}

export function AutomationsLog({ initialRuns }: { initialRuns: CronRunRow[] }) {
  const [runs, setRuns] = useState<CronRunRow[]>(initialRuns);
  const [fetchedAt, setFetchedAt] = useState<number>(() => Date.now());
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/automations/runs", { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as { runs?: CronRunRow[] };
        setRuns(data.runs ?? []);
      }
    } catch {
      // keep the last-known runs; the next poll retries
    } finally {
      setFetchedAt(Date.now());
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Fresh on open (the SSR snapshot can be a few seconds old), then every 30 min.
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const now = fetchedAt;
  const latestByJob = new Map<string, CronRunRow>();
  for (const r of runs) if (!latestByJob.has(r.job)) latestByJob.set(r.job, r);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-mist-500">
          Auto-refreshes every 30 minutes · updated{" "}
          {new Date(now).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
        </p>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="focus-ring inline-flex min-h-9 items-center gap-2 rounded-md border border-input bg-card px-3 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
        >
          {loading ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : <RefreshCw className="size-4" strokeWidth={1.75} />}
          Refresh
        </button>
      </div>

      {/* per-job health grid */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {CRON_JOBS.map((job) => {
          const last = latestByJob.get(job.slug);
          const ageMs = last ? now - new Date(last.started_at).getTime() : Infinity;
          const overdue = ageMs > job.maxAgeMins * 60000;
          return (
            <Card key={job.slug} className="p-4">
              <div className="flex items-start justify-between gap-2">
                <p className="font-medium text-foreground">{job.label}</p>
                {last ? <StatusChip status={last.status} /> : null}
              </div>
              <p className="mt-0.5 text-xs text-mist-400">{job.cadence}</p>
              <p className="mt-2 text-sm text-mist-500">{job.description}</p>
              <div className="mt-3 flex items-center gap-2 border-t border-border pt-2.5 text-xs">
                {last ? (
                  <>
                    <span className={cn(overdue ? "font-semibold text-warn" : "text-mist-500")}>
                      Last run {relative(last.started_at, now)}
                    </span>
                    {overdue ? (
                      <span className="inline-flex items-center gap-1 rounded-pill bg-warn-bg px-1.5 py-0.5 font-semibold text-warn">
                        <AlertTriangle className="size-3" strokeWidth={2} /> overdue
                      </span>
                    ) : null}
                  </>
                ) : (
                  <span className="text-mist-400">No runs recorded yet</span>
                )}
              </div>
            </Card>
          );
        })}
      </div>

      {/* chronological log */}
      <div>
        <h2 className="mb-2 font-display text-lg font-semibold text-foreground">Recent runs</h2>
        <Card className="p-0">
          {runs.length === 0 ? (
            <EmptyState
              icon={Clock}
              title="No automation runs yet"
              hint="Scheduled jobs will appear here as they fire — each run records what it did."
            />
          ) : (
            <ul className="divide-y">
              {runs.map((r) => {
                const pairs = summaryPairs(r.summary);
                return (
                  <li key={r.id} className="flex flex-col gap-1.5 px-4 py-3 sm:flex-row sm:items-center sm:gap-4 sm:px-5">
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      <StatusChip status={r.status} />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-foreground">
                          {LABEL_BY_SLUG.get(r.job) ?? r.job}
                        </span>
                        <span className="block text-xs text-mist-400">
                          {fmtTime(r.started_at)} · {relative(r.started_at, now)}
                          {r.duration_ms != null ? ` · ${fmtDuration(r.duration_ms)}` : ""}
                        </span>
                      </span>
                    </div>
                    <div className="min-w-0 sm:max-w-[55%] sm:text-right">
                      {r.error ? (
                        <span className="text-xs font-medium text-danger">{r.error}</span>
                      ) : pairs.length ? (
                        <span className="text-xs text-mist-500">{pairs.join(" · ")}</span>
                      ) : (
                        <span className="text-xs text-mist-400">no changes</span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
