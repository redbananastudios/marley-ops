import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The chase cron's DRIVING WINDOW.
 *
 * Commercial is excluded from the chase engine entirely (PRD §3.10), and
 * nothing ever removes an excluded lead from the population the window reads:
 * it stays 'quoted'/'provisional' (the only automatic write of 'confirmed' is
 * inside markDepositPaid, which commercial never reaches, and the 30-day
 * auto-lapse is excluded for the same reason), and `quote_chase_at` is stamped
 * only after a send it never gets. So every excluded lead parks permanently in
 * the `nullsFirst` block and the set grows monotonically.
 *
 * A single capped head-of-order read therefore fills with rows the run cannot
 * act on, and every lead behind them silently stops being chased — no quote
 * chases, no deposit reminders, no hand-to-human tasks, no lapses — while the
 * run still records 'ok' with all counters at zero, indistinguishable from a
 * quiet Sunday. That is the precise failure the comment above the query says
 * must never happen, arriving by a route the comment did not anticipate.
 *
 * A source guard rather than a behaviour test because a route file exports only
 * its handler, so there is nothing to call: the property being protected is the
 * SHAPE of the read, and the same reasoning the commercial-exclusion guard
 * states (one missed spot is silent) applies here.
 */

const CRON = readFileSync(join(process.cwd(), "app/api/cron/chase/route.ts"), "utf8");

/** The cron with `//` comment lines stripped — a guard must assert on CODE, or
 *  the prose explaining why something is wrong satisfies the check. */
const CODE = CRON.split("\n")
  .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
  .join("\n");

/** The statement that reads the chaseable-lead population. */
const DRIVING_READ = (() => {
  const marker = CODE.indexOf('.in("status", ["quoted", "provisional"])');
  expect(marker, "the driving leads read must still be recognisable").toBeGreaterThan(-1);
  return CODE.slice(CODE.lastIndexOf("await sb", marker), CODE.indexOf(";", marker) + 1);
})();

describe("the chase window cannot be starved by leads it may not act on", () => {
  it("reads the population in windows, not as one capped head", () => {
    // `.limit(n)` takes the first n rows of an ordering whose front is occupied
    // by permanently-parked rows. `.range()` lets the scan keep looking past
    // them, so an excluded lead costs a read rather than a customer.
    expect(DRIVING_READ).toContain(".range(");
    expect(DRIVING_READ).not.toMatch(/\.limit\(/);
  });

  it("orders by a total key, so successive windows tile the set exactly once", () => {
    // quote_chase_at is NULL across the whole parked block, so it is not an
    // order at all there: without a unique tiebreak, paging over it can return
    // a row twice and skip another entirely.
    expect(DRIVING_READ).toMatch(/\.order\("quote_chase_at"/);
    expect(DRIVING_READ).toMatch(/\.order\("id"/);
  });

  it("fills the run's window with leads that survived the exclusion", () => {
    // The window has to be ACCUMULATED from filtered pages. Filtering a single
    // capped read after the fact removes the rows from the loop but not from
    // the slots they occupied, which is the whole defect.
    expect(CODE).toMatch(/const leads: LeadRow\[\] = \[\];/);
    expect(CODE).toMatch(/leads\.push\(/);
    // And the filter that decides it is still the policy-aware one.
    expect(CODE).toContain("chaseableQuotes(");
  });

  it("a scan that gave up before the population ran out says so", () => {
    // "I could not look at all of it" is a different answer from "nothing was
    // due", and a run that cannot tell them apart is the failure this file
    // exists to prevent.
    expect(CODE).toContain("chaseScanTruncated");
    expect(CODE).toContain("cron.chase.scan_ceiling_hit");
  });
});
