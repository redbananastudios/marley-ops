"use client";

/**
 * Registers the push service worker once per dashboard session (idle, after
 * hydration). Registration is safe and silent — it never asks for permission
 * (that only happens from the explicit Enable gesture in Settings) — but
 * keeping the worker registered means updates propagate and an existing
 * subscription keeps its handler after the SW is evicted.
 */

import { useEffect } from "react";

export function PushSwRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // Best-effort: a failed registration only matters once the user tries
        // to enable notifications, where the failure surfaces properly.
      });
    };
    // Defer off the critical path (PRD §19).
    if ("requestIdleCallback" in window) {
      (window as Window & { requestIdleCallback: (cb: () => void) => number }).requestIdleCallback(register);
    } else {
      setTimeout(register, 2000);
    }
  }, []);
  return null;
}
