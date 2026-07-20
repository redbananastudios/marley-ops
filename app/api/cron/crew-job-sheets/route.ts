import { NextResponse } from "next/server";
import { requireUserOrCronSecret } from "@/lib/api-auth";
import { runCron } from "@/lib/cron/run-logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { dispatchCrewJobSheets } from "@/lib/crew-sheet/dispatch";

/**
 * Crew job-sheet delivery (crew-reliability PRD A1). Runs every few minutes:
 * at 18:00 UK the evening before it emails each assigned crew member their day
 * sheet (PDF) + texts a login-less link; when a job changes it re-sends a
 * clearly-superseding copy within one cron tick; a transient send failure is
 * retried and surfaced. All the logic lives in lib/crew-sheet/dispatch.ts.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request) {
  if (!(await requireUserOrCronSecret(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const run = await runCron("crew-job-sheets", async (): Promise<Record<string, unknown>> => {
    const admin = createAdminClient();
    return { ...(await dispatchCrewJobSheets(admin)) };
  });
  return NextResponse.json(
    { ok: run.ok, ...(run.summary ?? {}), ...(run.error ? { error: run.error } : {}) },
    { status: run.status },
  );
}
