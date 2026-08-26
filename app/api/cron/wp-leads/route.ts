import { NextResponse } from "next/server";
import { requireUserOrCronSecret } from "@/lib/api-auth";
import { runCron } from "@/lib/cron/run-logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { syncWpLeads } from "@/lib/sync/wp-leads";

/**
 * Pitmans WordPress lead pull (cron, every 15 min): poll the lead-bridge
 * plugin's signed read endpoint on pitmansremovals.co.uk and land any enquiry
 * the direct push missed, under brand `pitmans`. The disjoint half of gate
 * 19's two-rail ingest (multi-brand PRD §3.8) — the plugin must never ship
 * without this running, because push-only loses enquiries silently.
 *
 * While PITMANS_WP_PULL_URL / PITMANS_WP_PULL_SECRET are unset the run
 * reports `configured: false` with a loud warning rather than pretending to
 * have checked anything; a half-set pair is a FAILED run. Idempotent — a
 * healthy push means every poll counts alreadyPresent and writes nothing.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: Request) {
  if (!(await requireUserOrCronSecret(req))) {
    return NextResponse.json({ ok: false, error: "Unauthorised" }, { status: 401 });
  }
  const run = await runCron("wp-leads", async () => {
    const sb = createAdminClient();
    return (await syncWpLeads(sb)) as unknown as Record<string, unknown>;
  });
  return NextResponse.json(
    { ok: run.ok, ...(run.summary ?? {}), ...(run.error ? { error: run.error } : {}) },
    { status: run.status },
  );
}
