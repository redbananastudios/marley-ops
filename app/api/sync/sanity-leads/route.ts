import { NextResponse } from "next/server";
import { syncSanityLeads } from "@/lib/sync/sanity-leads";
import { watchLeadDeliveries } from "@/lib/sync/lead-delivery-watch";
import { requireUserOrCronSecret } from "@/lib/api-auth";
import { runCron } from "@/lib/cron/run-logger";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Manual "Sync leads" button → full sync (also refreshes existing rows).
 *  Callable by a signed-in user, or by a cron with `Authorization: Bearer <SYNC_CRON_SECRET>`. */
export async function GET(req: Request) {
  if (!(await requireUserOrCronSecret(req))) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const run = await runCron("sanity-leads-sync", async () => {
    const sync = await syncSanityLeads();
    // Then check the OTHER rail. The instant push leaves no trace in this
    // database when it fails -- the pull silently covers for it -- so the only
    // place the failure is visible is the site's own delivery audit in Sanity.
    // Reported separately so a degraded push never masquerades as a sync fault,
    // and so a push problem cannot be hidden by a healthy sync.
    const push = await watchLeadDeliveries();
    if (!push.ok) log.warn("lead-push.check_failed", { error: push.error, since: push.since });
    return { ...sync, push } as unknown as Record<string, unknown>;
  });
  return NextResponse.json(run.summary ?? { ok: false, error: run.error }, { status: run.status });
}

export async function POST(req: Request) {
  return GET(req);
}
