import { NextResponse } from "next/server";
import { requireUserOrCronSecret } from "@/lib/api-auth";
import { runCron } from "@/lib/cron/run-logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { reconcileCardPayments } from "@/lib/payments/card-payments";

/**
 * Card-payment reconciler (cron): QUERY every takepayments attempt still
 * pending after 10 minutes and settle it from the gateway's answer. The
 * server callback is the instant path; this is the safety net for a missed
 * callback (the gateway documents no retry) and for abandoned HPP tabs, which
 * are swept to `abandoned` after 24h.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  if (!(await requireUserOrCronSecret(req))) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const run = await runCron("card-reconcile", async () => {
    const sb = createAdminClient();
    return reconcileCardPayments(sb);
  });
  return NextResponse.json(
    { ok: run.ok, ...(run.summary ?? {}), ...(run.error ? { error: run.error } : {}) },
    { status: run.status },
  );
}
