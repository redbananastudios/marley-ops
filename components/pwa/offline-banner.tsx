"use client";

/**
 * Persistent, unmissable offline indicator for the crew app (crew-reliability
 * PRD A2). A fixed bottom bar — the same corner as the UpdateBanner, so it
 * never fights the sticky header — that appears the moment the device drops
 * signal and clears the moment it returns. Paired with <LastUpdated/> (which
 * shows WHEN the on-screen data was last synced), a crew member is never misled
 * into trusting stale jobs.
 *
 * navigator.onLine is the fast signal; it can lie (says online on a dead Wi-Fi),
 * but the network-first SW + honest "last updated" stamp are the real guard —
 * this bar is the loud, obvious cue the PRD asks for.
 */

import { useEffect, useState } from "react";
import { WifiOff } from "lucide-react";

export function OfflineBanner() {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    const sync = () => setOffline(!navigator.onLine);
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);

  if (!offline) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 bottom-0 z-[60] flex items-center justify-center gap-2 border-t border-amber-300 bg-amber-100 px-4 py-2.5 text-sm font-semibold text-amber-900 shadow-[0_-1px_6px_rgba(0,0,0,0.08)]"
      style={{ paddingBottom: "calc(0.625rem + env(safe-area-inset-bottom))" }}
    >
      <WifiOff className="size-4 shrink-0" strokeWidth={2} />
      You&apos;re offline — showing your saved jobs
    </div>
  );
}
