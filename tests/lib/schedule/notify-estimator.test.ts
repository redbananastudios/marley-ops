import { describe, it, expect } from "vitest";
import { ukSlotLabel } from "@/lib/schedule/notify-estimator";
import { surveyAssignedPush } from "@/lib/push/categories";

describe("ukSlotLabel", () => {
  it("renders a UK wall-clock slot", () => {
    // 13:00 UTC in August is 14:00 UK (BST).
    expect(ukSlotLabel("2026-08-14T13:00:00.000Z")).toBe("Friday 14 August at 14:00");
  });

  it("holds UK time across the GMT boundary", () => {
    // Same UTC instant in January is 13:00 UK (GMT) — the label must not drift.
    expect(ukSlotLabel("2026-01-14T13:00:00.000Z")).toBe("Wednesday 14 January at 13:00");
  });

  it("returns null rather than 'Invalid Date' for junk", () => {
    expect(ukSlotLabel(null)).toBeNull();
    expect(ukSlotLabel(undefined)).toBeNull();
    expect(ukSlotLabel("not-a-date")).toBeNull();
  });
});

describe("surveyAssignedPush", () => {
  const base = {
    appointmentId: "appt-1",
    customerName: "Alina Bradshaw",
    startsAt: "2026-08-14T13:00:00.000Z",
    leadId: "lead-1",
  };

  it("is lock-screen safe: first name only, never address, phone or money", () => {
    for (const kind of ["booked", "moved", "removed", "cancelled"] as const) {
      const p = surveyAssignedPush({ ...base, kind });
      expect(p.body).toContain("Alina");
      expect(p.body).not.toContain("Bradshaw");
      expect(p.body).not.toMatch(/£|\d{5,}|Bimport/);
    }
  });

  it("uses one stable tag per appointment so a change REPLACES the stale ping", () => {
    const booked = surveyAssignedPush({ ...base, kind: "booked" });
    const cancelled = surveyAssignedPush({ ...base, kind: "cancelled" });
    expect(booked.eventKey).toBe(cancelled.eventKey);
    expect(booked.eventKey).toBe("survey-assigned-appt-1");
  });

  it("tells a cancelled estimator not to travel, and never implies cover", () => {
    const p = surveyAssignedPush({ ...base, kind: "cancelled" });
    expect(p.title).toBe("Survey cancelled");
    expect(p.body).toContain("Don't travel");
    expect(p.body).not.toContain("someone else");
  });

  it("distinguishes a hand-off from a cancellation", () => {
    expect(surveyAssignedPush({ ...base, kind: "removed" }).body).toContain("gone to someone else");
  });

  it("sends a person who no longer owns the visit to their diary, not the lead", () => {
    expect(surveyAssignedPush({ ...base, kind: "removed" }).url).toBe("/schedule/surveys");
    expect(surveyAssignedPush({ ...base, kind: "cancelled" }).url).toBe("/schedule/surveys");
    expect(surveyAssignedPush({ ...base, kind: "booked" }).url).toBe("/leads/lead-1");
    expect(surveyAssignedPush({ ...base, kind: "moved" }).url).toBe("/leads/lead-1");
  });

  it("degrades without a lead or a date instead of printing holes", () => {
    const p = surveyAssignedPush({ ...base, kind: "booked", leadId: null, startsAt: null });
    expect(p.url).toBe("/schedule/surveys");
    expect(p.body).toBe("You're surveying Alina.");
    expect(p.body).not.toContain("null");
    expect(p.body).not.toContain("undefined");
  });

  it("falls back to a neutral noun when the customer has no name", () => {
    const p = surveyAssignedPush({ ...base, kind: "booked", customerName: null });
    expect(p.body).toContain("A customer");
  });
});
