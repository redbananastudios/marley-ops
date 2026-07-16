import { NextResponse } from "next/server";
import { requireUserOrCronSecret } from "@/lib/api-auth";
import { runCron } from "@/lib/cron/run-logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { runHealthWatchdog } from "@/lib/watchdog";

/**
 * Health watchdog (cron, every 15 min): freshness-checks every registered
 * automation + the bank feed and SMSes OPS_ALERT_SMS (WebEx) when something
 * is wrong, with a 6h cooldown per alert set. `?smstest=1` sends a one-off
 * test SMS to prove the alerting leg end to end.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  if (!(await requireUserOrCronSecret(req))) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const forceTestSms = new URL(req.url).searchParams.get("smstest") === "1";
  const run = await runCron("health-watchdog", async () => {
    const sb = createAdminClient();
    return runHealthWatchdog(sb, { forceTestSms });
  });
  return NextResponse.json(
    { ok: run.ok, ...(run.summary ?? {}), ...(run.error ? { error: run.error } : {}) },
    { status: run.status },
  );
}
