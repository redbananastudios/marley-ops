import { NextResponse } from "next/server";
import { requireOfficeOrCronSecret } from "@/lib/api-auth";
import { runCron } from "@/lib/cron/run-logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { syncBankFeed } from "@/lib/bank-feed/sync";

/**
 * Bank-feed sync (cron, every 2 min): pull the Monzo→Google-Sheets export,
 * upsert by transaction id, and (re)match inbound faster payments against
 * awaiting deposits/balances. Produces SUGGESTIONS only — the office confirms
 * on /payments. No-ops cleanly (disabled:true) until the BANK_FEED_* env is
 * present, so the route can ship ahead of the credentials.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  // Office or cron only — crew are RLS-walled from bank data and must not be
  // able to trigger sheet reads or read the money-flow summary.
  if (!(await requireOfficeOrCronSecret(req))) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const run = await runCron("bank-feed", async () => {
    const sb = createAdminClient();
    return syncBankFeed(sb);
  });
  return NextResponse.json(
    { ok: run.ok, ...(run.summary ?? {}), ...(run.error ? { error: run.error } : {}) },
    { status: run.status },
  );
}
