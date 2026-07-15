"use client";

/**
 * Registers the push service worker once per dashboard session (idle, after
 * hydration). Registration is safe and silent — it never asks for permission
 * (that only happens from the explicit Enable gesture in Settings) — but
 * keeping the worker registered means updates propagate and an existing
 * subscription keeps its handler after the SW is evicted.
 *
 * Self-update guarantees (installed PWAs live for months):
 *  - updateViaCache: "none" — the update check always bypasses HTTP cache.
 *  - reg.update() on every app launch AND whenever the app returns to the
 *    foreground, so a long-lived install picks up a new worker within one
 *    resume instead of the browser's up-to-24h heuristic.
 *  - The worker itself calls skipWaiting()+clients.claim(), so a fetched
 *    update activates immediately — no trapped-waiting state. The app's
 *    PAGES never go stale in the first place: there is no fetch/caching
 *    handler, every navigation is served live.
 */

import { useEffect } from "react";

export function PushSwRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    let reg: ServiceWorkerRegistration | null = null;

    const register = async () => {
      try {
        reg = await navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });
        await reg.update().catch(() => {});
      } catch {
        // Best-effort: a failed registration only matters once the user tries
        // to enable notifications, where the failure surfaces properly.
      }
    };

    // Defer off the critical path (PRD §19).
    if ("requestIdleCallback" in window) {
      (window as Window & { requestIdleCallback: (cb: () => void) => number }).requestIdleCallback(
        () => void register(),
      );
    } else {
      setTimeout(() => void register(), 2000);
    }

    // An installed PWA can sit in the app switcher for days — check for a new
    // worker every time it comes back to the foreground.
    const onVisible = () => {
      if (document.visibilityState === "visible") reg?.update().catch(() => {});
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);
  return null;
}
