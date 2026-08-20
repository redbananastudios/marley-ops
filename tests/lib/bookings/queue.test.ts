import { describe, expect, it } from "vitest";
import { classifyBooking, daysBetweenUk, owedNow, type QueueSignals } from "@/lib/bookings/queue";

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

/**
 * owedNow is the money the office can actually ask for today. It is separate
 * from classifyBooking on purpose: the bucket ladder puts a booking in exactly
 * one place, which used to let an unpaid deposit hide the balance on a job
 * moving the same week (QA-20260820-04). These tests pin the two rules Peter
 * set on 2026-08-20: deposits are never "owed now", and a job inside the
 * 7-day window owes its money.
 */
const owedBase = {
  commitmentInvoiceAmount: 0,
  commitmentPaidAt: null as string | null,
  commitmentDueDate: null as string | null,
  dateReleasableAt: null as string | null,
  balanceAmount: 1700,
  balancePaidAt: null as string | null,
  balanceInvoiceNumber: null as string | null,
  hasRemovalAppt: true,
  apptDayUk: "2026-08-20",
};

describe("owedNow", () => {
  it("NEVER counts the deposit — an unpaid deposit adds nothing to owed-now", () => {
    // Deposit state is not even an input: the only money here is the balance,
    // and it is outside the window, so nothing is owed today.
    const far = owedNow({ ...owedBase, apptDayUk: "2026-09-30" }, TODAY);
    expect(far.total).toBe(0);
  });

  it("counts the balance for a job inside the 7-day window", () => {
    const inWindow = owedNow({ ...owedBase, apptDayUk: "2026-08-05" }, "2026-08-01");
    expect(inWindow.balance).toBe(1700);
    expect(inWindow.total).toBe(1700);
    expect(inWindow.overdue).toBe(0);
  });

  it("still counts the balance when the deposit was never paid (the bug)", () => {
    // The ladder would call this booking deposit_outstanding and report £0
    // balance. The money is owed regardless of which rung is unpaid.
    const moveDay = owedNow({ ...owedBase, apptDayUk: "2026-08-01" }, "2026-08-01");
    expect(moveDay.total).toBe(1700);
  });

  it("treats a passed move day as overdue", () => {
    const past = owedNow({ ...owedBase, apptDayUk: "2026-07-25" }, TODAY);
    expect(past.balance).toBe(1700);
    expect(past.overdue).toBe(1700);
  });

  it("adds the invoiced 25% to the balance without double-counting", () => {
    // balanceAmount is already agreed − deposit − commitment, so the two sum
    // to everything outstanding after the deposit.
    const both = owedNow(
      { ...owedBase, commitmentInvoiceAmount: 450, apptDayUk: "2026-08-02" },
      "2026-08-01",
    );
    expect(both.commitment).toBe(450);
    expect(both.balance).toBe(1700);
    expect(both.total).toBe(2150);
  });

  it("owes nothing when there is no move behind the balance", () => {
    expect(owedNow({ ...owedBase, hasRemovalAppt: false, apptDayUk: null }, TODAY).total).toBe(0);
  });

  it("owes nothing once the money is paid", () => {
    expect(
      owedNow(
        { ...owedBase, apptDayUk: "2026-07-25", balancePaidAt: "2026-07-26T10:00:00Z" },
        TODAY,
      ).total,
    ).toBe(0);
    expect(
      owedNow(
        { ...owedBase, commitmentInvoiceAmount: 450, commitmentPaidAt: "2026-07-01T09:00:00Z", apptDayUk: "2026-09-30" },
        TODAY,
      ).total,
    ).toBe(0);
  });

  it("marks an invoiced 25% overdue once its due date passes, or the T-7 flag is set", () => {
    const late = owedNow(
      { ...owedBase, commitmentInvoiceAmount: 450, commitmentDueDate: "2026-07-20", apptDayUk: "2026-09-30" },
      TODAY,
    );
    expect(late.overdue).toBe(450);
    const flagged = owedNow(
      { ...owedBase, commitmentInvoiceAmount: 450, dateReleasableAt: "2026-07-29T00:00:00Z", apptDayUk: "2026-09-30" },
      TODAY,
    );
    expect(flagged.overdue).toBe(450);
  });
});
