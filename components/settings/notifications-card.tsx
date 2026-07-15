"use client";

/**
 * Settings › Notifications. Wraps the push setup flow in the Settings card
 * shell (mirrors QuickSigninCard).
 */

import { BellRing } from "lucide-react";
import { Card } from "@/components/ui/card";
import { NotificationsSetup } from "@/components/push/notifications-setup";

export function NotificationsCard({ isAdmin }: { isAdmin: boolean }) {
  return (
    <Card className="p-0">
      <div className="flex items-center gap-3 border-b px-5 py-3.5">
        <BellRing className="size-5 shrink-0 text-mm-red" strokeWidth={1.75} />
        <div>
          <h2 className="font-display text-lg font-semibold text-foreground">Notifications</h2>
          <p className="mt-0.5 text-xs text-mist-400">
            Get alerted about new enquiries and payments on this device — even when the app is closed.
          </p>
        </div>
      </div>
      <div className="p-5">
        <NotificationsSetup isAdmin={isAdmin} />
      </div>
    </Card>
  );
}
