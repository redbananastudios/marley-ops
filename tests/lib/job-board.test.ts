import { describe, expect, it } from "vitest";
import {
  apptDays,
  apptWindow,
  apptsClash,
  clashesFor,
  crewRequired,
  resourceDayState,
  type ApptLite,
} from "@/lib/job-board";

// July = BST (UTC+1). 2026-07-13 is a Monday.
const appt = (o: Partial<ApptLite>): ApptLite => ({
  id: "a",
  starts_at: null,
  ends_at: null,
  all_day: false,
  ...o,
});

describe("apptDays", () => {
  it("single timed appointment sits on its UK day", () => {
    expect(apptDays(appt({ starts_at: "2026-07-13T09:00:00+01:00", ends_at: "2026-07-13T13:00:00+01:00" }))).toEqual([
      "2026-07-13",
    ]);
  });

  it("multi-day move spans every day it touches", () => {
    expect(
      apptDays(appt({ starts_at: "2026-07-13T08:00:00+01:00", ends_at: "2026-07-15T17:00:00+01:00", all_day: true })),
    ).toEqual(["2026-07-13", "2026-07-14", "2026-07-15"]);
  });

  it("an appointment ending exactly at midnight does not own the next day", () => {
    expect(apptDays(appt({ starts_at: "2026-07-13T20:00:00+01:00", ends_at: "2026-07-14T00:00:00+01:00" }))).toEqual([
      "2026-07-13",
    ]);
  });

  it("a UTC-stamped evening appt lands on the correct BST day", () => {
    // 23:30 UTC = 00:30 next day in London
    expect(apptDays(appt({ starts_at: "2026-07-13T23:30:00Z", ends_at: "2026-07-14T01:00:00Z" }))).toEqual([
      "2026-07-14",
    ]);
  });

  it("open-ended timed appt gets a default duration on its own day", () => {
    expect(apptDays(appt({ starts_at: "2026-07-13T09:00:00+01:00" }))).toEqual(["2026-07-13"]);
  });
});

describe("apptWindow", () => {
  it("formats the UK time window", () => {
    expect(apptWindow(appt({ starts_at: "2026-07-13T09:00:00+01:00", ends_at: "2026-07-13T13:30:00+01:00" }))).toBe(
      "09:00–13:30",
    );
  });
  it("all-day reads as All day", () => {
    expect(apptWindow(appt({ starts_at: "2026-07-13T09:00:00+01:00", all_day: true }))).toBe("All day");
  });
});

describe("apptsClash", () => {
  const morning = appt({ id: "m", starts_at: "2026-07-13T09:00:00+01:00", ends_at: "2026-07-13T12:00:00+01:00" });
  const afternoon = appt({ id: "p", starts_at: "2026-07-13T13:00:00+01:00", ends_at: "2026-07-13T17:00:00+01:00" });
  const overlap = appt({ id: "o", starts_at: "2026-07-13T11:00:00+01:00", ends_at: "2026-07-13T14:00:00+01:00" });
  const allDay = appt({ id: "d", starts_at: "2026-07-13T08:00:00+01:00", all_day: true });

  it("timed appointments clash only when intervals overlap", () => {
    expect(apptsClash(morning, afternoon)).toBe(false);
    expect(apptsClash(morning, overlap)).toBe(true);
    expect(apptsClash(overlap, afternoon)).toBe(true);
  });

  it("back-to-back appointments do not clash", () => {
    const next = appt({ id: "n", starts_at: "2026-07-13T12:00:00+01:00", ends_at: "2026-07-13T13:00:00+01:00" });
    expect(apptsClash(morning, next)).toBe(false);
  });

  it("an all-day appointment clashes with anything sharing the day", () => {
    expect(apptsClash(allDay, morning)).toBe(true);
    expect(apptsClash(allDay, appt({ id: "t", starts_at: "2026-07-14T09:00:00+01:00" }))).toBe(false);
  });
});

describe("resourceDayState", () => {
  const timed = appt({ id: "t", starts_at: "2026-07-13T09:00:00+01:00", ends_at: "2026-07-13T12:00:00+01:00" });
  const allDay = appt({ id: "d", starts_at: "2026-07-13T08:00:00+01:00", all_day: true });

  it("free with nothing assigned that day", () => {
    expect(resourceDayState("2026-07-13", [])).toBe("free");
    expect(resourceDayState("2026-07-14", [timed])).toBe("free");
  });
  it("partial for timed work, booked for all-day", () => {
    expect(resourceDayState("2026-07-13", [timed])).toBe("partial");
    expect(resourceDayState("2026-07-13", [timed, allDay])).toBe("booked");
  });
});

describe("clashesFor", () => {
  const move = appt({ id: "move", starts_at: "2026-07-13T08:00:00+01:00", all_day: true });
  const survey = appt({ id: "survey", starts_at: "2026-07-13T10:00:00+01:00", ends_at: "2026-07-13T11:00:00+01:00" });
  const byId = new Map([
    ["move", move],
    ["survey", survey],
  ]);

  it("finds the clashing assignment and excludes the target itself", () => {
    const assignments = [
      { appointment_id: "move", staff_id: "jack", vehicle_id: null },
      { appointment_id: "survey", staff_id: "jack", vehicle_id: null },
    ];
    expect(clashesFor("jack", "staff", survey, assignments, byId).map((a) => a.id)).toEqual(["move"]);
    expect(clashesFor("jack", "staff", move, assignments, byId).map((a) => a.id)).toEqual(["survey"]);
  });

  it("no clash for a different resource or a clear day", () => {
    const assignments = [{ appointment_id: "move", staff_id: "jack", vehicle_id: null }];
    expect(clashesFor("luke", "staff", survey, assignments, byId)).toEqual([]);
    const tuesday = appt({ id: "tue", starts_at: "2026-07-14T09:00:00+01:00" });
    expect(clashesFor("jack", "staff", tuesday, assignments, byId)).toEqual([]);
  });
});

describe("crewRequired", () => {
  it("derives vans + men from the quote shape", () => {
    expect(crewRequired({ vehicle: "1luton" })).toEqual({ vans: 1, men: 2 });
    expect(crewRequired({ vehicle: "2luton" })).toEqual({ vans: 2, men: 3 });
    expect(crewRequired({ vehicle: "2luton", sevenFiveT: 1 })).toEqual({ vans: 3, men: 4 });
    expect(crewRequired({ vehicle: "1luton", transitVans: 1 })).toEqual({ vans: 2, men: 3 });
    expect(crewRequired({ vehicle: "transit" })).toEqual({ vans: 1, men: 1 });
  });
  it("honours the legacy has75T flag and rejects unknown shapes", () => {
    expect(crewRequired({ vehicle: "1luton", has75T: true })).toEqual({ vans: 2, men: 3 });
    expect(crewRequired(null)).toBeNull();
    expect(crewRequired({ vehicle: "hovercraft" })).toBeNull();
  });
});
