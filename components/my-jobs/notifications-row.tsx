"use client";

/**
 * Crew entry point for push notifications (Peter, 2026-07-15). Crew never see
 * Settings — this row below their job list is where they enable "you're on a
 * job / you're off a job" alerts on their own phone. Mirrors QuickSigninRow.
 */

import { BellRing, ChevronDown } from "lucide-react";
import { NotificationsSetup } from "@/components/push/notifications-setup";

export function NotificationsRow() {
  return (
    <details className="group mt-3 rounded-xl border border-border bg-card">
      <summary className="focus-ring flex cursor-pointer list-none items-center gap-2 rounded-xl px-4 py-3 text-sm font-medium text-mist-500 hover:text-foreground">
        <BellRing className="size-4 shrink-0 text-mist-400" strokeWidth={1.75} />
        Get job alerts on this phone
        <ChevronDown
          className="ml-auto size-4 text-mist-400 transition-transform group-open:rotate-180"
          strokeWidth={1.75}
        />
      </summary>
      <div className="border-t border-border px-4 py-4">
        <p className="mb-3 text-sm text-mist-500">
          Get a notification when you&apos;re put on a job — or taken off one — even when this app is
          closed.
        </p>
        <NotificationsSetup isAdmin={false} />
      </div>
    </details>
  );
}
