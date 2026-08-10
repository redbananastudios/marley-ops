import { describe, it, expect } from "vitest";
import { isCustomerSendHour, sendWindowReason, SEND_HOUR_UK } from "@/lib/comms/send-window";

/**
 * These assert against UTC instants deliberately. The whole point of the fix is
 * that the box runs on UTC and the app must decide which UTC hour is really
 * 09:00 in London — so a test written in local time would prove nothing.
 */
describe("isCustomerSendHour", () => {
  it("sends at 09:00 UK in SUMMER, which is 08:00 UTC", () => {
    // 10 Aug 2026 is BST (UTC+1).
    expect(isCustomerSendHour(new Date("2026-08-10T08:00:00Z"))).toBe(true);
    expect(isCustomerSendHour(new Date("2026-08-10T08:59:59Z"))).toBe(true);
  });

  it("does NOT send at 09:00 UTC in summer — that is 10:00 UK", () => {
    // This is exactly what was happening: the fixed `0 9 * * *` crontab entry
    // was landing an hour late for seven months of the year.
    expect(isCustomerSendHour(new Date("2026-08-10T09:00:00Z"))).toBe(false);
  });

  it("sends at 09:00 UK in WINTER, which is 09:00 UTC", () => {
    // 10 Jan 2026 is GMT (UTC+0).
    expect(isCustomerSendHour(new Date("2026-01-10T09:00:00Z"))).toBe(true);
    expect(isCustomerSendHour(new Date("2026-01-10T08:00:00Z"))).toBe(false);
  });

  it("means exactly one of the two cron hours fires, all year", () => {
    for (const day of ["2026-01-10", "2026-03-29", "2026-08-10", "2026-10-25", "2026-12-25"]) {
      const fires = [`${day}T08:00:00Z`, `${day}T09:00:00Z`].filter((iso) =>
        isCustomerSendHour(new Date(iso)),
      );
      expect(fires, `two sends or none on ${day}`).toHaveLength(1);
    }
  });

  it("holds sends at every other hour of the day", () => {
    for (let h = 0; h < 24; h++) {
      const iso = `2026-08-10T${String(h).padStart(2, "0")}:30:00Z`;
      // 08:30 UTC is 09:30 UK in BST — the only hour that passes.
      expect(isCustomerSendHour(new Date(iso))).toBe(h === 8);
    }
  });

  it("holds an ad-hoc afternoon run — the 17:01 sends that started this", () => {
    expect(isCustomerSendHour(new Date("2026-08-10T16:01:00Z"))).toBe(false);
  });

  it("sends every day of the week, including the weekend", () => {
    // Sat 8 Aug and Sun 9 Aug 2026 (Peter, 2026-08-10: seven days a week).
    expect(isCustomerSendHour(new Date("2026-08-08T08:15:00Z"))).toBe(true);
    expect(isCustomerSendHour(new Date("2026-08-09T08:15:00Z"))).toBe(true);
  });
});

describe("sendWindowReason", () => {
  it("names the hour it actually is in UK terms, not UTC", () => {
    const r = sendWindowReason(new Date("2026-08-10T16:01:00Z"));
    expect(r).toContain("17:xx UK");
    expect(r).toContain(`${SEND_HOUR_UK}:00 UK`);
  });
});
