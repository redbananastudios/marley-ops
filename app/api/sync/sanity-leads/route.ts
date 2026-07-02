import { NextResponse } from "next/server";
import { syncSanityLeads } from "@/lib/sync/sanity-leads";
import { requireUserOrCronSecret } from "@/lib/api-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Manual "Sync leads" button → full sync (also refreshes existing rows).
 *  Callable by a signed-in user, or by a cron with `Authorization: Bearer <SYNC_CRON_SECRET>`. */
export async function GET(req: Request) {
  if (!(await requireUserOrCronSecret(req))) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const result = await syncSanityLeads();
  return NextResponse.json(result, { status: 200 });
}

export async function POST(req: Request) {
  return GET(req);
}
