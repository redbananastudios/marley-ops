import { NextResponse } from "next/server";
import { syncSanityLeads } from "@/lib/sync/sanity-leads";
import { requireUserOrCronSecret } from "@/lib/api-auth";
import { runCron } from "@/lib/cron/run-logger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Manual "Sync leads" button → full sync (also refreshes existing rows).
 *  Callable by a signed-in user, or by a cron with `Authorization: Bearer <SYNC_CRON_SECRET>`. */
export async function GET(req: Request) {
  if (!(await requireUserOrCronSecret(req))) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const run = await runCron("sanity-leads-sync", async () => (await syncSanityLeads()) as unknown as Record<string, unknown>);
  return NextResponse.json(run.summary ?? { ok: false, error: run.error }, { status: run.status });
}

export async function POST(req: Request) {
  return GET(req);
}
