"use client";

/**
 * Lightweight launch surface for the guided tour — deliberately free of any
 * driver.js import so menu buttons (sidebar footer, crew header) can trigger a
 * relaunch without pulling the tour engine into their bundle. The mounted
 * <OnboardingTour> (tour.tsx) listens for the event and does the driving.
 */

import { cn } from "@/lib/utils";
import type { TourName } from "./tours";

export const START_TOUR_EVENT = "mm:start-tour";

/** localStorage flag — set on finish OR dismiss so we never nag a returning user. */
export const tourDoneKey = (name: TourName): string => `mm-tour-done:${name}`;

/** Relaunch a tour by name. Safe on the server (no-op); dispatches on the client. */
export function startTour(name: TourName): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(START_TOUR_EVENT, { detail: name }));
}

/** A "Take the tour" trigger. Styling is passed in so it can sit on the black
 *  sidebar rail or the light crew header without a variant prop. */
export function TourButton({
  tour,
  className,
  children,
  icon,
}: {
  tour: TourName;
  className?: string;
  children?: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={() => startTour(tour)}
      className={cn("focus-ring inline-flex min-h-11 items-center gap-2", className)}
    >
      {icon}
      {children ?? "Take the tour"}
    </button>
  );
}
