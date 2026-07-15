"use client";

/**
 * Pull-to-refresh for the INSTALLED app (Peter, 2026-07-15). Browser tabs
 * already have native pull-to-refresh; a standalone PWA has no browser
 * chrome at all — on iOS there isn't even a reload control — so this fills
 * the gap. Active only in standalone display-mode on touch devices, so it
 * can never fight the browser's own gesture.
 *
 * Behaviour: pull down from the very top of the page → an indicator follows
 * the drag → release past the threshold → full reload (which, with no SW
 * page caching, is also how the app picks up a fresh deploy).
 *
 * Guards: ignores pulls that start inside a scrolled nested scroller or an
 * open dialog (a stray pull must never reload someone mid-quote-wizard).
 */

import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";

const THRESHOLD = 72; // px of (damped) pull that arms the refresh
const MAX_PULL = 110;
const DAMPING = 0.45;

function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** True when the touch began inside a scrolled inner scroller or a dialog —
 *  contexts where a downward drag means "scroll/interact", never "refresh". */
function touchIsCaptured(target: EventTarget | null): boolean {
  if (document.querySelector('[role="dialog"]')) return true;
  let el = target instanceof Element ? target : null;
  while (el && el !== document.body) {
    if (el.scrollTop > 0) return true;
    el = el.parentElement;
  }
  return false;
}

export function PullToRefresh() {
  const [enabled, setEnabled] = useState(false);
  const indicatorRef = useRef<HTMLDivElement | null>(null);
  const iconRef = useRef<SVGSVGElement | null>(null);
  const startYRef = useRef<number | null>(null);
  const pullRef = useRef(0);
  const refreshingRef = useRef(false);

  useEffect(() => {
    setEnabled(isStandalone() && "ontouchstart" in window);
  }, []);

  useEffect(() => {
    if (!enabled) return;

    const indicator = () => indicatorRef.current;

    const setPull = (pull: number, withTransition: boolean) => {
      pullRef.current = pull;
      const el = indicator();
      if (!el) return;
      el.style.transition = withTransition ? "transform 180ms ease-out, opacity 180ms ease-out" : "none";
      el.style.transform = `translateX(-50%) translateY(${pull - 56}px)`;
      el.style.opacity = pull > 4 ? "1" : "0";
      if (iconRef.current && !refreshingRef.current) {
        iconRef.current.style.transform = `rotate(${(pull / THRESHOLD) * 270}deg)`;
        iconRef.current.style.opacity = pull >= THRESHOLD ? "1" : "0.55";
      }
    };

    const onTouchStart = (e: TouchEvent) => {
      if (refreshingRef.current || e.touches.length !== 1) return;
      const scroller = document.scrollingElement ?? document.documentElement;
      if (scroller.scrollTop > 0) return;
      if (touchIsCaptured(e.target)) return;
      startYRef.current = e.touches[0].clientY;
    };

    const onTouchMove = (e: TouchEvent) => {
      if (startYRef.current === null || refreshingRef.current) return;
      const scroller = document.scrollingElement ?? document.documentElement;
      const dy = e.touches[0].clientY - startYRef.current;
      if (dy <= 0 || scroller.scrollTop > 0) {
        setPull(0, false);
        return;
      }
      // We own this gesture now — stop the page rubber-banding underneath.
      if (e.cancelable) e.preventDefault();
      setPull(Math.min(dy * DAMPING, MAX_PULL), false);
    };

    const finish = () => {
      if (startYRef.current === null) return;
      startYRef.current = null;
      if (pullRef.current >= THRESHOLD && !refreshingRef.current) {
        refreshingRef.current = true;
        if (iconRef.current) {
          iconRef.current.style.transform = "";
          iconRef.current.style.opacity = "1";
          iconRef.current.classList.add("animate-spin");
        }
        setPull(THRESHOLD, true);
        window.location.reload();
      } else {
        setPull(0, true);
      }
    };

    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("touchend", finish, { passive: true });
    window.addEventListener("touchcancel", finish, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", finish);
      window.removeEventListener("touchcancel", finish);
    };
  }, [enabled]);

  if (!enabled) return null;

  return (
    <div
      ref={indicatorRef}
      aria-hidden
      className="pointer-events-none fixed left-1/2 top-0 z-50 flex size-11 items-center justify-center rounded-full border bg-card opacity-0 shadow-md"
      style={{ transform: "translateX(-50%) translateY(-56px)" }}
    >
      <RefreshCw ref={iconRef} className="size-5 text-mm-red" strokeWidth={2} />
    </div>
  );
}
