"use client";

/**
 * "Updated HH:MM" stamp for a crew read surface (crew-reliability PRD A2). The
 * server bakes the render time into the page (`at`), so when this same HTML is
 * later served from the offline cache the stamp still reads the LAST time it was
 * genuinely fetched — an honest freshness signal, never a fake "now".
 *
 * Goes amber + "offline" when the device has no signal, so a stale copy is
 * obvious at the point of reading, not just via the bottom banner.
 */

import { useEffect, useState } from "react";
import { RotateCw } from "lucide-react";

const hhmm = (iso: string): string => {
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? ""
    : d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Europe/London" });
};

export function LastUpdated({ at }: { at: string }) {
  const [offline, setOffline] = useState(false);
  const time = hhmm(at);

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

  if (!time) return null;

  return (
    <span
      className={
        "inline-flex items-center gap-1 text-xs font-medium " + (offline ? "text-amber-700" : "text-mist-400")
      }
    >
      <RotateCw className="size-3" strokeWidth={2} />
      {offline ? `Offline · last updated ${time}` : `Updated ${time}`}
    </span>
  );
}
