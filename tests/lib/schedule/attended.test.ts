import { describe, it, expect } from "vitest";
import {
  isAttendedSurvey,
  attendedSurveys,
  pendingSurveyLeadIds,
  latestAttendedSurveyAt,
} from "@/lib/schedule/attended";

const NOW = new Date("2026-08-09T12:00:00.000Z");

const at = (start: string, end: string | null, status: string | null = "scheduled") => ({
  starts_at: start,
  ends_at: end,
  status,
});

describe("isAttendedSurvey", () => {
  it("counts a past visit that is still on the schedule", () => {
    // Peter's rule: not deleted (so the row still exists) => it happened.
    expect(isAttendedSurvey(at("2026-08-07T09:00:00Z", "2026-08-07T10:00:00Z"), NOW)).toBe(true);
  });

  it("counts a past visit whether or not anyone pressed Create Quote", () => {
    // The old filter was status='completed', set only by that one button. A
    // survey quoted over the phone, from the estimator page, or from the tablet
    // stayed 'scheduled' forever and vanished from every figure.
    expect(isAttendedSurvey(at("2026-08-07T09:00:00Z", "2026-08-07T10:00:00Z", "scheduled"), NOW)).toBe(true);
    expect(isAttendedSurvey(at("2026-08-07T09:00:00Z", "2026-08-07T10:00:00Z", "completed"), NOW)).toBe(true);
  });

  it("does NOT count a cancelled visit", () => {
    // Cancelling emails the customer "please don't wait in" — an explicit
    // statement that nobody went. Counting it would inflate visits and drag
    // win rate down with visits that never happened.
    expect(isAttendedSurvey(at("2026-08-07T09:00:00Z", "2026-08-07T10:00:00Z", "cancelled"), NOW)).toBe(false);
  });

  it("does NOT count a visit that has not happened yet", () => {
    expect(isAttendedSurvey(at("2026-08-14T09:00:00Z", "2026-08-14T10:00:00Z"), NOW)).toBe(false);
  });

  it("does NOT count a visit still in progress", () => {
    // Started an hour ago, ends in an hour — not over, so not yet attended.
    expect(isAttendedSurvey(at("2026-08-09T11:00:00Z", "2026-08-09T13:00:00Z"), NOW)).toBe(false);
  });

  it("counts a visit the instant its slot closes", () => {
    expect(isAttendedSurvey(at("2026-08-09T11:00:00Z", "2026-08-09T12:00:00Z"), NOW)).toBe(true);
  });

  it("falls back to the start when no end is recorded", () => {
    expect(isAttendedSurvey(at("2026-08-07T09:00:00Z", null), NOW)).toBe(true);
    expect(isAttendedSurvey(at("2026-08-14T09:00:00Z", null), NOW)).toBe(false);
  });

  it("refuses to guess on an unparseable or missing date", () => {
    expect(isAttendedSurvey({ starts_at: null, ends_at: null }, NOW)).toBe(false);
    expect(isAttendedSurvey(at("not-a-date", null), NOW)).toBe(false);
  });
});

describe("attendedSurveys", () => {
  it("keeps only the visits that happened, preserving order", () => {
    const rows = [
      { id: "past", ...at("2026-08-07T09:00:00Z", "2026-08-07T10:00:00Z") },
      { id: "cancelled", ...at("2026-08-06T09:00:00Z", "2026-08-06T10:00:00Z", "cancelled") },
      { id: "future", ...at("2026-08-20T09:00:00Z", "2026-08-20T10:00:00Z") },
      { id: "past2", ...at("2026-08-08T09:00:00Z", "2026-08-08T10:00:00Z", "completed") },
    ];
    expect(attendedSurveys(rows, NOW).map((r) => r.id)).toEqual(["past", "past2"]);
  });

  it("returns an empty list rather than throwing on an empty set", () => {
    expect(attendedSurveys([], NOW)).toEqual([]);
  });
});

describe("pendingSurveyLeadIds", () => {
  const appt = (lead_id: string | null, start: string, status: string | null = "scheduled") => ({
    lead_id,
    starts_at: start,
    ends_at: null,
    status,
  });

  it("holds the chase for a lead whose visit is still to come", () => {
    // Luke quotes on the phone, then visits two days later. Without this the
    // day-2 chase asks "anything you'd like changed?" the morning of the visit.
    expect([...pendingSurveyLeadIds([appt("lead-1", "2026-08-14T09:00:00Z")], NOW)]).toEqual(["lead-1"]);
  });

  it("releases the chase once the visit has happened", () => {
    expect(pendingSurveyLeadIds([appt("lead-1", "2026-08-07T09:00:00Z")], NOW).size).toBe(0);
  });

  it("still holds while the visit is in progress", () => {
    const inProgress = { lead_id: "lead-1", starts_at: "2026-08-09T11:00:00Z", ends_at: "2026-08-09T13:00:00Z", status: "scheduled" };
    expect(pendingSurveyLeadIds([inProgress], NOW).has("lead-1")).toBe(true);
  });

  it("does not hold for a cancelled visit — nobody is coming", () => {
    expect(pendingSurveyLeadIds([appt("lead-1", "2026-08-14T09:00:00Z", "cancelled")], NOW).size).toBe(0);
  });

  it("does not mute a lead forever on an unusable date", () => {
    // Erring toward silence here would kill every follow-up for that customer
    // with nothing to show why, so a broken timestamp releases the ladder.
    expect(pendingSurveyLeadIds([appt("lead-1", "not-a-date")], NOW).size).toBe(0);
    expect(pendingSurveyLeadIds([{ lead_id: "lead-1", starts_at: null, ends_at: null, status: "scheduled" }], NOW).size).toBe(0);
  });

  it("ignores rows with no lead", () => {
    expect(pendingSurveyLeadIds([appt(null, "2026-08-14T09:00:00Z")], NOW).size).toBe(0);
  });

  it("holds a lead when ANY of its visits is still ahead", () => {
    const rows = [appt("lead-1", "2026-08-05T09:00:00Z"), appt("lead-1", "2026-08-20T09:00:00Z")];
    expect(pendingSurveyLeadIds(rows, NOW).has("lead-1")).toBe(true);
  });
});

describe("latestAttendedSurveyAt", () => {
  const appt = (lead_id: string, start: string, status: string | null = "scheduled") => ({
    lead_id,
    starts_at: start,
    ends_at: null,
    status,
  });

  it("gives the most recent visit, so a re-visited lead restarts from the latest", () => {
    const rows = [appt("lead-1", "2026-08-03T09:00:00Z"), appt("lead-1", "2026-08-07T09:00:00Z")];
    expect(latestAttendedSurveyAt(rows, NOW).get("lead-1")).toBe("2026-08-07T09:00:00Z");
  });

  it("ignores visits that have not happened and ones that were cancelled", () => {
    const rows = [
      appt("lead-1", "2026-08-20T09:00:00Z"),
      appt("lead-2", "2026-08-05T09:00:00Z", "cancelled"),
    ];
    expect(latestAttendedSurveyAt(rows, NOW).size).toBe(0);
  });

  it("has nothing to say about a lead that was never visited", () => {
    expect(latestAttendedSurveyAt([], NOW).get("lead-1")).toBeUndefined();
  });
});
