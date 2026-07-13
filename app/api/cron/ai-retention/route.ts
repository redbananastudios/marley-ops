import { NextResponse } from "next/server";

import { requireOfficeProfile } from "@/lib/ai/auth";
import { runAiRetention } from "@/lib/ai/retention";
import { requireUserOrCronSecret } from "@/lib/api-auth";
import { runCron } from "@/lib/cron/run-logger";

function hasSchedulerSecret(request: Request): boolean {
  const authorization = request.headers.get("authorization");
  return [process.env.CRON_SECRET, process.env.SYNC_CRON_SECRET].some((secret) => !!secret && authorization === `Bearer ${secret}`);
}

export async function GET(request: Request) {
  if (!(await requireUserOrCronSecret(request))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasSchedulerSecret(request) && !(await requireOfficeProfile())) return NextResponse.json({ error: "Office access required" }, { status: 403 });
  const run = await runCron("ai-retention", async () => (await runAiRetention()) as unknown as Record<string, unknown>);
  return NextResponse.json(run.summary ?? { ok: false, error: run.error }, { status: run.status });
}
