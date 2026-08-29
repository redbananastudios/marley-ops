import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { removalCompleted, ukDayOfInstant } from "@/lib/bookings/load-signals";

/**
 * "Is the job done" on a multi-day removal.
 *
 * `jobCompleted` used to be read off the EARLIEST removal appointment, because
 * that is the entry already looked up for the move date. The two questions are
 * not the same one: a two-day job crewed Friday and Saturday flips its Friday
 * entry to 'completed' at Friday's sign-off, so on Friday evening /bookings read
 * "completed — raise the invoice" for a job with a van still going out in the
 * morning. On a commercial booking that is the trigger for the invoice itself.
 *
 * Multiple live removals on one lead are ordinary rather than exotic: the manual
 * createAppointment path has no duplicate guard.
 */
describe("removalCompleted", () => {
  it("a two-day job is NOT done when the first day is signed off and the second is not", () => {
    // The exact Friday-evening shape, in query order (earliest first) — which
    // is what made reading the first entry look right.
    expect(
      removalCompleted([{ status: "completed" }, { status: "scheduled" }]),
    ).toBe(false);
  });

  it("is done once every removal day is signed off", () => {
    expect(removalCompleted([{ status: "completed" }, { status: "completed" }])).toBe(true);
    expect(removalCompleted([{ status: "completed" }])).toBe(true);
  });

  it("out-of-order sign-off reads as NOT done, which is the safe direction", () => {
    // Saturday closed, Friday forgotten. Asking only about the LATEST entry
    // would call this finished; asking whether anything is still outstanding
    // parks it in "awaiting completion" where the office can see it. Delaying
    // an invoice is visible; invoicing a job that is still running is not.
    expect(removalCompleted([{ status: "scheduled" }, { status: "completed" }])).toBe(false);
  });

  it("a single unfinished day is not done", () => {
    expect(removalCompleted([{ status: "scheduled" }])).toBe(false);
  });

  it("a lead with no removal appointment at all has not completed anything", () => {
    // `every` is vacuously true on an empty list, so without the length guard a
    // booking with nothing in the diary would report itself finished — and a
    // commercial one would invite an invoice for a job never carried out.
    expect(removalCompleted([])).toBe(false);
  });

  it("an unknown status is not a completion", () => {
    expect(removalCompleted([{ status: null }])).toBe(false);
    expect(removalCompleted([{ status: "completed" }, { status: null }])).toBe(false);
  });
});

/**
 * The wiring. `removalCompleted` is only an answer if the loader asks it — and
 * the single-appointment read it replaces is one line, easy to reintroduce
 * while the diary lookup beside it still legitimately wants the earliest slot.
 */
describe("loadBookingRows asks the whole diary, not the first slot", () => {
  const src = readFileSync(join(process.cwd(), "lib/bookings/load-signals.ts"), "utf8");

  it("answers jobCompleted from every removal appointment on the lead", () => {
    expect(src).toContain("jobCompleted: removalCompleted(");
    expect(src).not.toContain('appt?.status === "completed"');
  });

  it("still keeps the EARLIEST appointment for the move date itself", () => {
    // The fix must not swap which slot the board shows or which entry the
    // change-date dialog opens — that would move residential move dates.
    expect(src).toContain("apptStartsAt: appt?.startsAt ?? null");
    expect(src).toContain("(a.starts_at as string) < cur.startsAt");
  });
});

describe("ukDayOfInstant", () => {
  it("buckets an all-day BST move by its London day, not the UTC slice", () => {
    // A Monday all-day move during BST is stored 23:00Z on the Sunday.
    expect(ukDayOfInstant("2026-08-16T23:00:00Z")).toBe("2026-08-17");
  });
});
