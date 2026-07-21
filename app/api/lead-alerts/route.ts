import { NextResponse } from "next/server";
import { getUnackedWebLeadsAction } from "@/app/actions/lead-alerts";

/**
 * GET /api/lead-alerts — the unacked-web-lead read behind the dashboard alarm
 * (components/alerts/new-lead-alert.tsx).
 *
 * This is a plain route handler ON PURPOSE, not a server action: the poller
 * fires on mount, on focus and on service-worker nudges — moments that can
 * overlap an in-flight router navigation. Server actions share the router's
 * client action queue, so an action dispatched mid-navigation supersedes it —
 * a mount-time action poll reproducibly swallowed the post-login /->/estimator
 * redirect (the page sat on / for 10s+). A fetch is navigation-inert.
 *
 * Auth: the shared office gate inside getUnackedWebLeadsAction (admin/estimator,
 * active) — anyone else gets an empty list, same as the action returned.
 */

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const leads = await getUnackedWebLeadsAction();
    return NextResponse.json({ leads });
  } catch {
    // Transient read failure — the poller keeps its last state and retries.
    return NextResponse.json({ error: "Could not load new-lead alerts." }, { status: 500 });
  }
}
