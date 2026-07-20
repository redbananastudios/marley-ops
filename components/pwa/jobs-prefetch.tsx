"use client";

/**
 * Warms the offline read-cache for the jobs a crew member is most likely to need
 * off-grid — today's and tomorrow's — right after the list loads (crew-reliability
 * PRD A2: "cache the current and next day's jobs on each successful load"). Each
 * href is fetched with the warm header so the service worker caches the document
 * even though it's a background (non-navigation) request. Best-effort and
 * deferred — a failed warm just means that job caches on first visit instead.
 */

import { useEffect } from "react";
import { WARM_HEADER } from "@/lib/pwa/cache-rules";

export function JobsPrefetch({ hrefs }: { hrefs: string[] }) {
  useEffect(() => {
    if (!hrefs.length || typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    let cancelled = false;

    const warm = async () => {
      if (!navigator.onLine) return;
      await navigator.serviceWorker.ready.catch(() => null);
      if (cancelled || !navigator.serviceWorker.controller) return; // SW not driving yet — next load will warm
      for (const href of hrefs) {
        if (cancelled || !navigator.onLine) return;
        try {
          await fetch(href, { headers: { [WARM_HEADER]: "1" }, credentials: "same-origin", cache: "no-store" });
        } catch {
          // dropped signal mid-warm — fine, we simply cached fewer
        }
      }
    };

    const t = setTimeout(() => void warm(), 1500); // off the critical path
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [hrefs]);

  return null;
}
