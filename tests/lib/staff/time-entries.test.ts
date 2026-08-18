import { describe, expect, it } from "vitest";
import {
  entryHours,
  formatTimeOfDay,
  loggedHoursByDate,
  parseTimeOfDay,
  seedLinesFromWork,
  timesLabel,
  type DayTimeEntry,
} from "@/lib/staff/time-entries";

const entry = (over: Partial<DayTimeEntry>): DayTimeEntry => ({
  work_date: "2026-08-17",
  started_at: "08:00",
  ended_at: "18:30",
  expense_amount: null,
  expense_note: null,
  has_receipt: true,
  ...over,
});

describe("parseTimeOfDay", () => {
  it("reads HH:MM and Postgres HH:MM:SS alike", () => {
    expect(parseTimeOfDay("08:30")).toBe(510);
    expect(parseTimeOfDay("08:30:00")).toBe(510); // a time column comes back with seconds
    expect(parseTimeOfDay("8:05")).toBe(485);
  });
  it("rejects garbage and out-of-range values", () => {
    expect(parseTimeOfDay("25:00")).toBeNull();
    expect(parseTimeOfDay("12:60")).toBeNull();
    expect(parseTimeOfDay("noon")).toBeNull();
    expect(parseTimeOfDay("")).toBeNull();
    expect(parseTimeOfDay(null)).toBeNull();
  });
});

describe("entryHours", () => {
  it("is the straight finish − start, lunch included", () => {
    expect(entryHours("08:00", "18:30")).toBe(10.5); // what the crew want paying for
    expect(entryHours("09:00", "17:00")).toBe(8);
  });
  it("a finish at or before the start is a typo, not an overnight shift", () => {
    expect(entryHours("18:00", "08:00")).toBeNull(); // log midnight-crossing work as two days
    expect(entryHours("08:00", "08:00")).toBeNull();
  });
  it("half-open entries are not billable hours", () => {
    expect(entryHours("08:00", null)).toBeNull();
    expect(entryHours(null, "18:00")).toBeNull();
  });
  it("keeps odd minutes to 2dp", () => {
    expect(entryHours("08:00", "16:20")).toBe(8.33); // 8h20m
  });
});

describe("timesLabel / formatTimeOfDay", () => {
  it("renders the evidence string the office approves against", () => {
    expect(timesLabel("08:00", "18:30:00")).toBe("08:00–18:30");
    expect(formatTimeOfDay(485)).toBe("08:05");
  });
  it("is null when either end is missing", () => {
    expect(timesLabel("08:00", null)).toBeNull();
  });
});

describe("loggedHoursByDate", () => {
  it("keys valid entries by day and skips half-open ones", () => {
    const m = loggedHoursByDate([
      entry({ work_date: "2026-08-17", started_at: "08:00", ended_at: "18:00" }),
      entry({ work_date: "2026-08-18", started_at: "07:30", ended_at: null }),
    ]);
    expect(m.get("2026-08-17")).toBe(10);
    expect(m.has("2026-08-18")).toBe(false);
  });
});

describe("seedLinesFromWork — the invoice reads what happened", () => {
  it("a logged day seeds its ACTUAL hours with the times in the description", () => {
    const lines = seedLinesFromWork(
      [{ date: "2026-08-17", label: "Move — Kong" }],
      [entry({ work_date: "2026-08-17", started_at: "08:00", ended_at: "18:30" })],
      13.5,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      work_date: "2026-08-17",
      quantity: 10.5,
      unit_amount: 13.5,
      amount: 141.75,
      source: "job",
    });
    expect(lines[0].description).toBe("Worked Mon 17 Aug (08:00–18:30) — Move — Kong");
  });

  it("an assigned day with nothing logged falls back to the standard 8-hour suggestion", () => {
    const lines = seedLinesFromWork([{ date: "2026-08-17", label: "Move — Kong" }], [], 15);
    expect(lines[0]).toMatchObject({ quantity: 8, amount: 120 });
    expect(lines[0].description).toBe("Worked Mon 17 Aug — Move — Kong"); // no times = no claim of times
  });

  it("a logged day with no assignment still earns a line — a yard day is real work", () => {
    const lines = seedLinesFromWork(
      [],
      [entry({ work_date: "2026-08-18", started_at: "09:00", ended_at: "13:00" })],
      15,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ work_date: "2026-08-18", quantity: 4, amount: 60 });
  });

  it("an expense rides as its own at-cost line AFTER the worked lines, never through the rate", () => {
    const lines = seedLinesFromWork(
      [{ date: "2026-08-17", label: "Move — Kong" }],
      [
        entry({
          work_date: "2026-08-17",
          started_at: "08:00",
          ended_at: "16:00",
          expense_amount: 34.5,
          expense_note: "Fuel",
        }),
      ],
      13.5,
    );
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({
      description: "Expenses Mon 17 Aug — Fuel",
      work_date: "2026-08-17",
      quantity: null,
      unit_amount: null,
      amount: 34.5,
      source: "expense",
    });
  });

  it("an expense-only entry adds NO hours line — fuel bought on a day off is still repayable", () => {
    const lines = seedLinesFromWork(
      [],
      [entry({ work_date: "2026-08-16", started_at: null, ended_at: null, expense_amount: 30, expense_note: "Fuel" })],
      15,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].source).toBe("expense");
  });

  it("an expense with no receipt says so ON the line — the office approves against evidence", () => {
    const lines = seedLinesFromWork(
      [],
      [
        entry({ work_date: "2026-08-17", started_at: null, ended_at: null, expense_amount: 30, expense_note: "Fuel", has_receipt: false }),
        entry({ work_date: "2026-08-18", started_at: null, ended_at: null, expense_amount: 12, expense_note: "Parking", has_receipt: true }),
      ],
      15,
    );
    expect(lines[0].description).toBe("Expenses Mon 17 Aug — Fuel (no receipt)");
    expect(lines[1].description).toBe("Expenses Tue 18 Aug — Parking"); // receipted = no flag
  });

  it("a half-open entry (start, no finish) on an assigned day falls back to the suggestion", () => {
    const lines = seedLinesFromWork(
      [{ date: "2026-08-17", label: "Move — Kong" }],
      [entry({ work_date: "2026-08-17", started_at: "08:00", ended_at: null })],
      15,
    );
    expect(lines[0]).toMatchObject({ quantity: 8 }); // never silently bill an unfinished claim
    expect(lines[0].description).not.toContain("08:00"); // and never show half the evidence
  });

  it("days sort chronologically with expenses grouped after all worked lines", () => {
    const lines = seedLinesFromWork(
      [
        { date: "2026-08-19", label: "Move — B" },
        { date: "2026-08-17", label: "Move — A" },
      ],
      [
        entry({ work_date: "2026-08-17", started_at: "08:00", ended_at: "16:00", expense_amount: 20, expense_note: "Fuel" }),
        entry({ work_date: "2026-08-19", started_at: "08:00", ended_at: "12:00" }),
      ],
      10,
    );
    expect(lines.map((l) => `${l.source}:${l.work_date}`)).toEqual([
      "job:2026-08-17",
      "job:2026-08-19",
      "expense:2026-08-17",
    ]);
  });

  it("no rate seeds £0 lines rather than inventing money (the action blocks rateless crew anyway)", () => {
    const lines = seedLinesFromWork(
      [],
      [entry({ work_date: "2026-08-17", started_at: "08:00", ended_at: "16:00" })],
      null,
    );
    expect(lines[0]).toMatchObject({ quantity: 8, unit_amount: null, amount: 0 });
  });
});
