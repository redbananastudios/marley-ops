"use client";

/**
 * "New version available" banner (Peter, 2026-07-15 — installed PWAs must
 * always end up on the latest build). The client bundle carries its baked
 * build SHA; /api/version returns the running server's. A mismatch means a
 * deploy landed since this page loaded → show a persistent bottom pill whose
 * Update button reloads (no SW caching, so a reload IS the update).
 *
 * Checks: on mount, whenever the app returns to the foreground (the main
 * path for installed PWAs resumed from the app switcher), and every 5 min
 * while open. Fails silent — a flaky network must never nag.
 */

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

const CHECK_INTERVAL_MS = 5 * 60_000;
const OWN_SHA = process.env.NEXT_PUBLIC_BUILD_SHA ?? "dev";

export function UpdateBanner() {
  const [serverSha, setServerSha] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);

  const check = useCallback(async () => {
    try {
      const res = await fetch("/api/version", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { sha?: string };
      if (typeof data.sha === "string" && data.sha) setServerSha(data.sha);
    } catch {
      // offline / transient — try again on the next trigger
    }
  }, []);

  useEffect(() => {
    void check();
    const interval = setInterval(() => void check(), CHECK_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [check]);

  // "dev" on either side means we're outside the deploy pipeline — never nag.
  const updateAvailable =
    serverSha !== null && serverSha !== "dev" && OWN_SHA !== "dev" && serverSha !== OWN_SHA;
  if (!updateAvailable) return null;

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-50 flex justify-center px-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
      role="status"
    >
      <div className="flex items-center gap-3 rounded-pill border border-white/10 bg-charcoal px-4 py-2.5 text-white shadow-lg">
        <span className="text-sm">A new version of Marley Ops is available.</span>
        <button
          type="button"
          onClick={() => {
            setReloading(true);
            window.location.reload();
          }}
          disabled={reloading}
          className="focus-ring flex h-9 shrink-0 items-center gap-1.5 rounded-pill bg-mm-red px-3.5 text-sm font-semibold text-white hover:bg-mm-red-deep disabled:opacity-60"
        >
          <RefreshCw className={`size-4 ${reloading ? "animate-spin" : ""}`} strokeWidth={2} />
          Update
        </button>
      </div>
    </div>
  );
}
