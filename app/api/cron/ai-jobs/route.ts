import { NextResponse } from "next/server";

import { requireOfficeProfile } from "@/lib/ai/auth";
import { createAiJobRuntime } from "@/lib/ai/job-runtime";
import { drainAiJobs } from "@/lib/ai/jobs";
import { requireUserOrCronSecret } from "@/lib/api-auth";
import { runCron } from "@/lib/cron/run-logger";

export const maxDuration = 800;

function hasSchedulerSecret(request: Request): boolean {
  const authorization = request.headers.get("authorization");
  return [process.env.CRON_SECRET, process.env.SYNC_CRON_SECRET].some(
    (secret) => !!secret && authorization === `Bearer ${secret}`,
  );
}

export async function GET(request: Request) {
  if (!(await requireUserOrCronSecret(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!hasSchedulerSecret(request) && !(await requireOfficeProfile())) {
    return NextResponse.json({ error: "Office access required" }, { status: 403 });
  }

  const run = await runCron("ai-jobs", async () => {
    const workerId = `http-${crypto.randomUUID()}`;
    const result = await drainAiJobs(createAiJobRuntime(), {
      workerId,
      deadlineAtMs: Date.now() + 780_000,
    });
    return result as unknown as Record<string, unknown>;
  });
  return NextResponse.json(run.summary ?? { ok: false, error: run.error }, { status: run.status });
}
