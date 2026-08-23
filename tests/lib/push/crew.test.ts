import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The cancelled-appointment guard is the whole point of these tests.
 *
 * `notifyCrewAssignmentChange` deliberately stays silent about cancelled
 * appointments so that admin housekeeping on dead rows never pings a phone.
 * The inside-7-day date change (`changeBookingDateAction`) cancels the old
 * appointment BEFORE the crew are taken off it — so a naive call from that
 * flow looks correctly wired and silently does nothing, which is exactly the
 * failure QA-20260823-01 recorded. `notifyThoughCancelled` is the narrow,
 * explicit opt-out for the one case where the cancellation IS the news.
 */

const mocks = vi.hoisted(() => ({
  appt: null as { id: string; starts_at: string | null; status: string } | null,
  staff: [] as { id: string; profile_id: string | null; is_active: boolean }[],
  sendPushForEvent: vi.fn(async () => {}),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/log", () => ({ log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() }, errorContext: () => ({}) }));
vi.mock("@/lib/push/send", () => ({ sendPushForEvent: mocks.sendPushForEvent }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    from: (table: string) => {
      if (table === "appointments") {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: mocks.appt }) }) }),
        };
      }
      // staff: .select(...).in(...).not(...) is awaited directly
      return {
        select: () => ({
          in: () => ({ not: async () => ({ data: mocks.staff }) }),
        }),
      };
    },
  })),
}));

import { notifyCrewAssignmentChange } from "@/lib/push/crew";

/** Tomorrow, so the "past jobs never ping" guard is never the reason we skip. */
function tomorrowIso(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString();
}

function yesterdayIso(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString();
}

describe("notifyCrewAssignmentChange", () => {
  beforeEach(() => {
    mocks.sendPushForEvent.mockClear();
    mocks.appt = { id: "appt-1", starts_at: tomorrowIso(), status: "scheduled" };
    mocks.staff = [{ id: "staff-1", profile_id: "user-1", is_active: true }];
  });

  it("does nothing when no staff changed", async () => {
    await notifyCrewAssignmentChange({ appointmentId: "appt-1", actorUserId: "office-1" });
    expect(mocks.sendPushForEvent).not.toHaveBeenCalled();
  });

  it("notifies a removed crew member on a live appointment", async () => {
    await notifyCrewAssignmentChange({
      appointmentId: "appt-1",
      removedStaffIds: ["staff-1"],
      actorUserId: "office-1",
    });
    expect(mocks.sendPushForEvent).toHaveBeenCalledTimes(1);
  });

  it("stays silent on a cancelled appointment by default (admin housekeeping)", async () => {
    mocks.appt = { id: "appt-1", starts_at: tomorrowIso(), status: "cancelled" };
    await notifyCrewAssignmentChange({
      appointmentId: "appt-1",
      removedStaffIds: ["staff-1"],
      actorUserId: "office-1",
    });
    expect(mocks.sendPushForEvent).not.toHaveBeenCalled();
  });

  it("NOTIFIES a cancelled appointment when the cancellation is the news", async () => {
    mocks.appt = { id: "appt-1", starts_at: tomorrowIso(), status: "cancelled" };
    await notifyCrewAssignmentChange({
      appointmentId: "appt-1",
      removedStaffIds: ["staff-1"],
      actorUserId: "office-1",
      notifyThoughCancelled: true,
    });
    expect(mocks.sendPushForEvent).toHaveBeenCalledTimes(1);
  });

  it("still refuses to ping about a job that already happened, flag or not", async () => {
    mocks.appt = { id: "appt-1", starts_at: yesterdayIso(), status: "cancelled" };
    await notifyCrewAssignmentChange({
      appointmentId: "appt-1",
      removedStaffIds: ["staff-1"],
      actorUserId: "office-1",
      notifyThoughCancelled: true,
    });
    expect(mocks.sendPushForEvent).not.toHaveBeenCalled();
  });

  it("skips staff with no linked login and inactive staff", async () => {
    mocks.staff = [
      { id: "staff-1", profile_id: null, is_active: true },
      { id: "staff-2", profile_id: "user-2", is_active: false },
    ];
    await notifyCrewAssignmentChange({
      appointmentId: "appt-1",
      removedStaffIds: ["staff-1", "staff-2"],
      actorUserId: "office-1",
    });
    expect(mocks.sendPushForEvent).not.toHaveBeenCalled();
  });

  it("a missing appointment row is never a reason to invent a push", async () => {
    mocks.appt = null;
    await notifyCrewAssignmentChange({
      appointmentId: "gone",
      removedStaffIds: ["staff-1"],
      actorUserId: "office-1",
      notifyThoughCancelled: true,
    });
    expect(mocks.sendPushForEvent).not.toHaveBeenCalled();
  });
});
