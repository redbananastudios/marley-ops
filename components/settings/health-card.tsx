"use client";

/**
 * Integration health — on-demand check of every external wire (DB, storage,
 * Resend, WebEx, Sanity, Maps, PostHog, Google Ads). Runs only on button press
 * so rendering Settings never burns API quota.
 */

import { useState } from "react";
import { Activity, CheckCircle2, CircleAlert, Loader2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { runHealthChecks, type HealthCheck } from "@/app/(dashboard)/settings/health-actions";

const ICON = {
  ok: <CheckCircle2 className="size-4 shrink-0 text-success" strokeWidth={2} />,
  warn: <CircleAlert className="size-4 shrink-0 text-warn" strokeWidth={2} />,
  fail: <XCircle className="size-4 shrink-0 text-danger" strokeWidth={2} />,
} as const;

export function HealthCard() {
  const [busy, setBusy] = useState(false);
  const [checks, setChecks] = useState<HealthCheck[] | null>(null);
  const [ranAt, setRanAt] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    try {
      const res = await runHealthChecks();
      if (!res.ok) {
        toast.error("Could not run the checks.");
        return;
      }
      setChecks(res.checks);
      setRanAt(res.ranAt);
      const fails = res.checks.filter((c) => c.status === "fail").length;
      const warns = res.checks.filter((c) => c.status === "warn").length;
      if (fails) toast.error(`${fails} integration${fails === 1 ? "" : "s"} failing.`);
      else if (warns) toast.warning(`All reachable — ${warns} warning${warns === 1 ? "" : "s"}.`);
      else toast.success("All integrations healthy.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-0">
      <div className="flex items-center justify-between border-b px-5 py-3.5">
        <div>
          <h2 className="font-display text-lg font-semibold text-foreground">Integration health</h2>
          <p className="mt-0.5 text-xs text-mist-400">
            Checks database, storage, email, SMS, Sanity, Maps, PostHog and Google Ads wiring.
          </p>
        </div>
        <Button size="sm" onClick={run} disabled={busy} className="h-9">
          {busy ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : <Activity className="size-4" strokeWidth={2} />}
          Run checks
        </Button>
      </div>

      {checks === null ? (
        <p className="px-5 py-8 text-center text-sm text-mist-400">
          Not run yet — press <span className="font-medium text-mist-500">Run checks</span> to test every connection.
        </p>
      ) : (
        <>
          <ul className="divide-y">
            {checks.map((c) => (
              <li key={c.name} className="flex items-start gap-3 px-5 py-3">
                <span className="mt-0.5">{ICON[c.status]}</span>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">{c.name}</p>
                  <p className="text-xs text-mist-400">{c.detail}</p>
                </div>
              </li>
            ))}
          </ul>
          {ranAt ? (
            <p className="border-t px-5 py-2.5 text-xs text-mist-400">
              Last run {new Date(ranAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
            </p>
          ) : null}
        </>
      )}
    </Card>
  );
}
