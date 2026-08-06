"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";

/**
 * On-demand refresh for /payments. Runs the bank-feed sync first (the same
 * office-authorised route the 2-minute cron hits; a clean no-op while the
 * feed is unconfigured) so the reload shows the sheet's newest transfers,
 * not just what the last cron pass already ingested.
 */
export function RefreshButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [pending, start] = useTransition();
  const spinning = busy || pending;
  return (
    <button
      type="button"
      onClick={() => {
        if (spinning) return;
        setBusy(true);
        start(async () => {
          try {
            const res = await fetch("/api/cron/bank-feed", { cache: "no-store" });
            if (!res.ok) toast.error("Bank sync failed — showing the latest recorded data.");
          } catch {
            toast.error("Bank sync failed — showing the latest recorded data.");
          } finally {
            router.refresh();
            setBusy(false);
          }
        });
      }}
      disabled={spinning}
      aria-label="Refresh"
      title="Sync the bank feed and reload"
      className="focus-ring ml-1 inline-flex size-9 items-center justify-center rounded-md border border-input bg-card text-mist-500 transition-colors hover:bg-muted disabled:opacity-60"
    >
      <RefreshCw className={`size-4 ${spinning ? "animate-spin" : ""}`} strokeWidth={2} />
    </button>
  );
}
