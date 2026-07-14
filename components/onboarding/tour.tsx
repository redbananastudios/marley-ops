"use client";

/**
 * <OnboardingTour> — the driver.js-powered guided tour. Mount one per surface:
 * the office dashboard layout gets tour="office", the crew /my-jobs page gets
 * tour="crew". Behaviour:
 *   - Auto-starts ~1.2s after mount on first login (localStorage flag absent).
 *   - Relaunches on the "mm:start-tour" event dispatched by startTour(), so the
 *     "Take the tour" menu items can rerun it.
 *   - Marks the localStorage flag done on finish OR dismiss (never nags).
 *
 * Steps are resolved to LIVE, VISIBLE elements at run time. A step whose element
 * is absent (or hidden — e.g. the desktop sidebar on a narrow viewport) drops to
 * a centred modal rather than mis-positioning against a display:none node.
 */

import { useEffect, useRef } from "react";
import { driver, type DriveStep } from "driver.js";
import "driver.js/dist/driver.css";
import { TOURS, type TourName, type TourStep } from "./tours";
import { START_TOUR_EVENT, tourDoneKey } from "./launch";

/** First rendered, non-hidden match — skips a display:none desktop sidebar on
 *  mobile so we spotlight the real element or fall back to a centred modal. */
function resolveVisible(selector?: string): HTMLElement | undefined {
  if (!selector || typeof document === "undefined") return undefined;
  const nodes = document.querySelectorAll<HTMLElement>(selector);
  for (const node of Array.from(nodes)) {
    if (node.getClientRects().length > 0) return node;
  }
  return undefined;
}

function toDriveSteps(steps: TourStep[]): DriveStep[] {
  return steps.map((s) => {
    const element = resolveVisible(s.selector);
    return {
      // Omit `element` entirely when nothing visible resolved → centred modal.
      ...(element ? { element } : {}),
      popover: {
        title: s.title,
        description: s.description,
        // Positioning hints only make sense when anchored to an element.
        ...(element && s.side ? { side: s.side } : {}),
        ...(element && s.align ? { align: s.align } : {}),
      },
    } satisfies DriveStep;
  });
}

export function OnboardingTour({
  tour,
  autoStart = true,
}: {
  tour: TourName;
  /** Present for API symmetry with the mount sites; behaviour keys off `tour`. */
  role?: string;
  autoStart?: boolean;
}) {
  const runningRef = useRef(false);

  useEffect(() => {
    function run() {
      if (runningRef.current) return;
      const steps = toDriveSteps(TOURS[tour]);
      if (steps.length === 0) return;
      const d = driver({
        showProgress: true,
        progressText: "{{current}} of {{total}}",
        nextBtnText: "Next",
        prevBtnText: "Back",
        doneBtnText: "Done",
        overlayColor: "#0d1117",
        overlayOpacity: 0.72,
        stagePadding: 6,
        stageRadius: 10,
        popoverClass: "mm-tour-popover",
        // Educational walkthrough — spotlighted controls stay non-interactive so
        // a stray click can't navigate away and abandon the tour mid-flow.
        disableActiveInteraction: true,
        smoothScroll: true,
        allowClose: true,
        steps,
        onDestroyed: () => {
          runningRef.current = false;
          try {
            localStorage.setItem(tourDoneKey(tour), "1");
          } catch {
            /* private mode / storage disabled — non-fatal */
          }
        },
      });
      runningRef.current = true;
      d.drive();
    }

    function onStartEvent(e: Event) {
      const name = (e as CustomEvent<TourName>).detail;
      if (name && name !== tour) return;
      run();
    }
    window.addEventListener(START_TOUR_EVENT, onStartEvent);

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (autoStart) {
      let done = false;
      try {
        done = localStorage.getItem(tourDoneKey(tour)) === "1";
      } catch {
        done = false;
      }
      if (!done) timer = setTimeout(run, 1200);
    }

    return () => {
      window.removeEventListener(START_TOUR_EVENT, onStartEvent);
      if (timer) clearTimeout(timer);
    };
  }, [tour, autoStart]);

  return null;
}
