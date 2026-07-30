import { describe, expect, it } from "vitest";
import { classifyBooking, daysBetweenUk, type QueueSignals } from "@/lib/bookings/queue";

const TODAY = "2026-07-30";

const base: QueueSignals = {
  depositPaidAt: "2026-07-01T10:00:00Z",
  hasRemovalAppt: false,
  apptDayUk: null,
  provisionalDate: null,
  approxWindow: null,
  approxMonth: null,
  commitmentPaidAt: null,
  commitmentInvoiceAmount: null,
  commitmentDueDate: null,
  dateReleasableAt: null,
  balancePaidAt: null,
  balanceInvoiceNumber: null,
};

describe("classifyBooking", () => {
  it("unpaid deposit always wins, whatever else is set", () => {
    expect(classifyBooking({ ...base, depositPaidAt: null, hasRemovalAppt: true, apptDayUk: "2026-08-10" }, TODAY)).toBe(
      "deposit_outstanding",
    );
  });

  it("deposit paid with nothing pencilled = no_date; any window signal = provisional", () => {
    expect(classifyBooking(base, TODAY)).toBe("no_date");
    expect(classifyBooking({ ...base, approxWindow: "mid-August" }, TODAY)).toBe("provisional");
    expect(classifyBooking({ ...base, approxMonth: "2026-08-01" }, TODAY)).toBe("provisional");
    expect(classifyBooking({ ...base, provisionalDate: "2026-08-14" }, TODAY)).toBe("provisional");
    expect(classifyBooking({ ...base, approxWindow: "   " }, TODAY)).toBe("no_date");
  });

  const booked: QueueSignals = { ...base, hasRemovalAppt: true, apptDayUk: "2026-08-20" };

  it("unpaid 25% buckets by due date; the T-7 flag always means overdue", () => {
    const owed = { ...booked, commitmentInvoiceAmount: 450 };
    expect(classifyBooking({ ...owed, commitmentDueDate: "2026-08-05" }, TODAY)).toBe("commitment_due");
    expect(classifyBooking({ ...owed, commitmentDueDate: "2026-07-29" }, TODAY)).toBe("commitment_overdue");
    expect(classifyBooking({ ...owed, dateReleasableAt: "2026-07-28T09:00:00Z" }, TODAY)).toBe("commitment_overdue");
    // due today is not overdue yet
    expect(classifyBooking({ ...owed, commitmentDueDate: TODAY }, TODAY)).toBe("commitment_due");
  });

  it("a paid (or never-raised) 25% falls through to the balance lifecycle", () => {
    expect(classifyBooking({ ...booked, commitmentInvoiceAmount: 450, commitmentPaidAt: "2026-07-20T09:00:00Z" }, TODAY)).toBe(
      "all_set",
    );
    expect(classifyBooking({ ...booked, commitmentInvoiceAmount: 0 }, TODAY)).toBe("all_set");
  });

  it("balance: overdue after move day, due when invoiced or inside the window, else all set", () => {
    expect(classifyBooking({ ...booked, apptDayUk: "2026-07-28" }, TODAY)).toBe("balance_overdue");
    expect(classifyBooking({ ...booked, balanceInvoiceNumber: "INV-000210" }, TODAY)).toBe("balance_due");
    expect(classifyBooking({ ...booked, apptDayUk: "2026-08-01" }, TODAY)).toBe("balance_due"); // 2 days out
    expect(classifyBooking(booked, TODAY)).toBe("all_set"); // 21 days out, not invoiced
    expect(classifyBooking({ ...booked, apptDayUk: "2026-07-28", balancePaidAt: "2026-07-28T18:00:00Z" }, TODAY)).toBe(
      "all_set",
    );
  });
});

describe("daysBetweenUk", () => {
  it("counts calendar days, negative for the past", () => {
    expect(daysBetweenUk("2026-07-30", "2026-08-01")).toBe(2);
    expect(daysBetweenUk("2026-07-30", "2026-07-30")).toBe(0);
    expect(daysBetweenUk("2026-07-30", "2026-07-28")).toBe(-2);
  });
});
