import { describe, expect, it } from "vitest";
import { buildWeekValues, type WeekValueJob } from "@/lib/schedule/week-value";

/** Mon 3 Aug 2026 and Mon 10 Aug 2026 — two adjacent calendar rows. */
const WEEKS = ["2026-08-03", "2026-08-10"];

const job = (over: Partial<WeekValueJob>): WeekValueJob => ({
  id: "a1",
  leadId: "l1",
  apptType: "removal",
  startDay: "2026-08-05",
  value: 1200,
  toCollect: 1100,
  ...over,
});

describe("buildWeekValues — what a week of removals is worth", () => {
  it("totals the removals in each Mon–Sun row", () => {
    const weeks = buildWeekValues(
      [
        job({ id: "a1", leadId: "l1", startDay: "2026-08-05", value: 1200, toCollect: 1100 }),
        job({ id: "a2", leadId: "l2", startDay: "2026-08-07", value: 800, toCollect: 700 }),
        job({ id: "a3", leadId: "l3", startDay: "2026-08-12", value: 500, toCollect: 0 }),
      ],
      WEEKS,
    );
    expect(weeks.get("2026-08-03")).toMatchObject({ jobCount: 2, agreedTotal: 2000, toCollect: 1800 });
    expect(weeks.get("2026-08-10")).toMatchObject({ jobCount: 1, agreedTotal: 500, toCollect: 0 });
  });

  it("a week with nothing booked reports zero jobs (the UI renders an empty rail, not '£0')", () => {
    const weeks = buildWeekValues([job({ startDay: "2026-08-05" })], WEEKS);
    expect(weeks.get("2026-08-10")).toMatchObject({ jobCount: 0, agreedTotal: 0, unpricedJobs: 0 });
  });

  it("a move spanning the week boundary counts ONCE, in the week it starts", () => {
    // Sunday 9th into Monday 10th: one job, one sale, and it belongs to the
    // week it began in — counting it in both would inflate the month by a job.
    const weeks = buildWeekValues([job({ startDay: "2026-08-09", value: 2400, toCollect: 2400 })], WEEKS);
    expect(weeks.get("2026-08-03")).toMatchObject({ jobCount: 1, agreedTotal: 2400 });
    expect(weeks.get("2026-08-10")).toMatchObject({ jobCount: 0, agreedTotal: 0 });
  });

  it("a pack day adds no money — it is the day-before labour for a move already counted", () => {
    const weeks = buildWeekValues(
      [
        job({ id: "a1", leadId: "l1", startDay: "2026-08-05", value: 1200, toCollect: 1200 }),
        job({ id: "a2", leadId: "l1", apptType: "pack", startDay: "2026-08-04", value: 1200, toCollect: 1200 }),
      ],
      WEEKS,
    );
    expect(weeks.get("2026-08-03")).toMatchObject({ jobCount: 1, agreedTotal: 1200 });
  });

  it("one lead with two removal rows counts once, on the earliest", () => {
    const weeks = buildWeekValues(
      [
        job({ id: "a1", leadId: "l1", startDay: "2026-08-12", value: 900, toCollect: 900 }),
        job({ id: "a2", leadId: "l1", startDay: "2026-08-05", value: 900, toCollect: 900 }),
      ],
      WEEKS,
    );
    expect(weeks.get("2026-08-03")).toMatchObject({ jobCount: 1, agreedTotal: 900 });
    expect(weeks.get("2026-08-10")).toMatchObject({ jobCount: 0, agreedTotal: 0 });
  });

  it("an unpriced removal counts as a job and is REPORTED, so the money is never quietly short", () => {
    const weeks = buildWeekValues(
      [
        job({ id: "a1", leadId: "l1", startDay: "2026-08-05", value: 1200, toCollect: 1200 }),
        job({ id: "a2", leadId: "l2", startDay: "2026-08-06", value: null, toCollect: null }),
        job({ id: "a3", leadId: null, startDay: "2026-08-07", value: null, toCollect: null }),
      ],
      WEEKS,
    );
    expect(weeks.get("2026-08-03")).toMatchObject({ jobCount: 3, unpricedJobs: 2, agreedTotal: 1200 });
  });

  it("a fully-paid job still shows its value but nothing left to collect", () => {
    const weeks = buildWeekValues([job({ value: 1500, toCollect: 0 })], WEEKS);
    expect(weeks.get("2026-08-03")).toMatchObject({ agreedTotal: 1500, toCollect: 0 });
  });

  it("jobs outside the drawn rows are ignored rather than folded into an edge week", () => {
    const weeks = buildWeekValues([job({ startDay: "2026-09-14" })], WEEKS);
    expect(weeks.get("2026-08-03")?.jobCount).toBe(0);
    expect(weeks.get("2026-08-10")?.jobCount).toBe(0);
  });

  it("names the jobs behind the count, in date order, so the figure can be checked", () => {
    // The grid can't be counted by eye (a two-day move draws twice, busy days
    // hide jobs behind "+N more"), so the rail must be able to show its working.
    const weeks = buildWeekValues(
      [
        job({ id: "a2", leadId: "l2", startDay: "2026-08-07", customer: "Kevin Mc Inerney" }),
        job({ id: "a1", leadId: "l1", startDay: "2026-08-05", customer: "Brydee Thomas" }),
        job({ id: "a3", leadId: "l3", startDay: "2026-08-06", customer: null }),
      ],
      WEEKS,
    );
    expect(weeks.get("2026-08-03")?.customers).toEqual(["Brydee Thomas", "Unnamed job", "Kevin Mc Inerney"]);
  });

  it("a two-day move contributes ONE name, not one per day", () => {
    const weeks = buildWeekValues(
      [job({ id: "a1", leadId: "l1", startDay: "2026-08-05", customer: "Justine Moyle" })],
      WEEKS,
    );
    expect(weeks.get("2026-08-03")?.customers).toEqual(["Justine Moyle"]);
  });

  it("every requested row gets an entry, with its Sunday end day", () => {
    const weeks = buildWeekValues([], WEEKS);
    expect(weeks.get("2026-08-03")).toMatchObject({ startDay: "2026-08-03", endDay: "2026-08-09" });
    expect(weeks.get("2026-08-10")).toMatchObject({ startDay: "2026-08-10", endDay: "2026-08-16" });
  });
});
