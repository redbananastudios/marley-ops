import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Card } from "@/components/ui/card";

/**
 * "Refunds waiting" needs-action card (Payments Policy v2, PRD §5D) — the
 * dashboard pointer at the /refunds queue. Visual twin of the ActionCard
 * pattern in dashboard-view.tsx, kept self-contained so it can mount without
 * touching that file's private helpers.
 *
 * NOT MOUNTED HERE BY DESIGN — the integration pass mounts it:
 *
 *   1. app/(dashboard)/page.tsx — add to the attention Promise.all:
 *        sb.from("refund_queue").select("id", { count: "exact", head: true }).eq("status", "pending")
 *      and thread the count into the dashboard data as `refundsWaiting`.
 *   2. components/dashboard/dashboard-view.tsx — add `refundsWaiting: number`
 *      to DashboardData["needsAction"] and render inside the needs-action grid:
 *        <RefundsWaitingCard count={data.needsAction.refundsWaiting} />
 *
 * Admin sees the count; the /refunds page itself re-gates server-side.
 */
export function RefundsWaitingCard({ count }: { count: number }) {
  const isEmpty = count === 0;
  return (
    <Link href="/refunds" className="focus-ring block rounded-lg">
      <Card className="p-5 transition-colors hover:bg-muted">
        <div className="flex items-start justify-between gap-2">
          <p className="eyebrow">Refunds waiting</p>
          <ChevronRight className="size-4 shrink-0 text-mist-300" strokeWidth={1.75} />
        </div>
        {isEmpty ? (
          <p className="mt-2 text-sm text-mist-400">No refunds waiting.</p>
        ) : (
          <p className="mt-1 font-display tabular text-4xl font-bold text-mm-red">{count}</p>
        )}
      </Card>
    </Link>
  );
}
