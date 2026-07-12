import { NextResponse } from "next/server";

import { requireOfficeProfile } from "@/lib/ai/auth";
import { runAiRetention } from "@/lib/ai/retention";
import { requireUserOrCronSecret } from "@/lib/api-auth";

function hasSchedulerSecret(request: Request): boolean {
  const authorization = request.headers.get("authorization");
  return [process.env.CRON_SECRET, process.env.SYNC_CRON_SECRET].some((secret) => !!secret && authorization === `Bearer ${secret}`);
}

export async function GET(request: Request) {
  if (!(await requireUserOrCronSecret(request))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasSchedulerSecret(request) && !(await requireOfficeProfile())) return NextResponse.json({ error: "Office access required" }, { status: 403 });
  return NextResponse.json(await runAiRetention());
}
