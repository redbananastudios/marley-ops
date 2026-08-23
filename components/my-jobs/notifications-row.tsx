"use client";

/**
 * Crew entry point for push notifications (Peter, 2026-07-15). Crew never see
 * Settings, so this row below their job list is where a phone gets enabled.
 * Mirrors QuickSigninRow.
 *
 * It renders ONLY when the viewer's role can actually receive something. Since
 * bd58fa0 retired crew_job (2026-08-23) every remaining category is office-only,
 * so crew get no panel rather than an opt-in that spends the browser's one-shot
 * permission prompt and then delivers nothing, forever, silently. Gating on the
 * category registry rather than on `role !== "crew"` means the row comes back by
 * itself the day a crew-audience category is added.
 */

import { BellRing, ChevronDown } from "lucide-react";
import { NotificationsSetup } from "@/components/push/notifications-setup";
import { pushCategoriesForRole } from "@/lib/push/categories";

export function NotificationsRow({ role }: { role: string }) {
  if (pushCategoriesForRole(role).length === 0) return null;

  return (
    <details className="group mt-3 rounded-xl border border-border bg-card">
      <summary className="focus-ring flex cursor-pointer list-none items-center gap-2 rounded-xl px-4 py-3 text-sm font-medium text-mist-500 hover:text-foreground">
        <BellRing className="size-4 shrink-0 text-mist-400" strokeWidth={1.75} />
        Get alerts on this phone
        <ChevronDown
          className="ml-auto size-4 text-mist-400 transition-transform group-open:rotate-180"
          strokeWidth={1.75}
        />
      </summary>
      <div className="border-t border-border px-4 py-4">
        {/* NotificationsSetup owns the copy for every state (unsupported, blocked,
            install-required, enabled…) and lists the categories this role really
            receives — a second hardcoded paragraph here is what went stale. */}
        <NotificationsSetup isAdmin={false} />
      </div>
    </details>
  );
}
