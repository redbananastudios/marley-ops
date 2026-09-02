import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The reschedule dialog's "estimator that day" panel — availability at a
 * glance before committing a new slot — rendered its times through bare
 * toLocaleTimeString and picked the day's events by the VIEWER's local
 * calendar date. lib/uk-time.ts's own header states the rule: anything a
 * client component RENDERS must pin Europe/London (the appointments are UK
 * jobs; a viewer an hour off sees the estimator's day shifted, and near
 * midnight sees the wrong DAY's bookings entirely — so the person
 * rescheduling double-books a slot the panel told them was clear).
 *
 * Source guards (node env, house convention): the render helper carries
 * UK_TZ, and the day-membership filter goes through ukCalendarDate rather
 * than a local-time slice.
 */

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

const at = (haystack: string, needle: string, what: string): number => {
  const i = haystack.indexOf(needle);
  expect(i, `no longer contains ${what}`).toBeGreaterThan(-1);
  return i;
};

const SRC = read("components/schedule/reschedule-dialog.tsx");

describe("reschedule dialog pins the estimator's day to Europe/London", () => {
  it("imports the UK_TZ helpers", () => {
    at(SRC, 'from "@/lib/uk-time"', "the uk-time import");
  });

  it("renders event times in UK time, not the viewer's zone", () => {
    const fmt = at(SRC, "toLocaleTimeString", "the time formatter");
    const tz = at(SRC, "timeZone: UK_TZ", "the pinned timezone");
    expect(fmt, "the timeZone pin must sit inside the formatter options").toBeLessThan(tz);
  });

  it("selects the day's bookings by UK calendar date", () => {
    at(SRC, "ukCalendarDate(e.starts_at)", "the UK-day membership check");
    expect(
      SRC.includes("toLocalInput(new Date(e.starts_at))"),
      "day membership still slices the viewer-local date",
    ).toBe(false);
  });
});
