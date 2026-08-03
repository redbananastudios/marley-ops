import { NextResponse } from "next/server";
import { requireUserOrCronSecret } from "@/lib/api-auth";
import { runCron } from "@/lib/cron/run-logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { runCommsRetry } from "@/lib/comms/retry-worker";

/**
 * Comms-retry worker (cron): re-drives any customer email/SMS whose provider
 * send failed or timed out, using the stored payload + the marley-comm/<id>
 * idempotency key so it can never double-send. Backs off, caps attempts, and
 * escalates to a critical issue instead of looping. The durable backstop behind
 * sendEmail's in-process retry.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  if (!(await requireUserOrCronSecret(req))) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const run = await runCron("comms-retry", async () => {
    const sb = createAdminClient();
    return runCommsRetry(sb);
  });
  return NextResponse.json(
    { ok: run.ok, ...(run.summary ?? {}), ...(run.error ? { error: run.error } : {}) },
    { status: run.status },
  );
}
