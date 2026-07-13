import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/api-auth";
import { createClient } from "@/lib/supabase/server";
import { log, errorContext } from "@/lib/log";

/**
 * Recent automation runs for the /automations page's 30-minute poll. Reads
 * through the signed-in user's client so RLS (cron_runs_read → is_office())
 * gates it to office/admin; crew never see the log.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await requireApiUser())) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  try {
    const sb = await createClient();
    const { data, error } = await sb
      .from("cron_runs")
      .select("id, job, status, started_at, finished_at, duration_ms, summary, error")
      .order("started_at", { ascending: false })
      .limit(100);
    if (error) {
      log.error("automations.runs.query_failed", { error: error.message });
      return NextResponse.json({ error: "Could not load automation runs" }, { status: 500 });
    }
    return NextResponse.json({ runs: data ?? [], fetchedAt: new Date().toISOString() });
  } catch (e) {
    log.error("automations.runs.threw", errorContext(e));
    return NextResponse.json({ error: "Could not load automation runs" }, { status: 500 });
  }
}
