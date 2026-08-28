import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every BookingBucket must be rendered by some section of /bookings.
 *
 * The type system cannot enforce this. `/bookings` and `/payments` dispatch by
 * FILTERING (`rows.filter(r => r.bucket === b)`), one call per bucket, rather
 * than by an exhaustive switch — so adding a bucket to the union compiles
 * cleanly, and any booking that classifies into it renders on no screen at all.
 * Silent, and invisible in exactly the way that matters: the row is a real job
 * with real money against it.
 *
 * This bit for real once already, one layer down: `/bookings` hid the
 * commitment queues behind a booked diary slot, so a date-confirmed job that
 * was never put in the diary had its 25% invoice on no screen (the reason
 * `payments-card.tsx` grew a commitment cell, and half of QA-20260826-01).
 *
 * So the guard is a source assertion rather than a render test: cheap, and it
 * fails the moment a bucket is added without a home.
 */

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

/** The union members, read from the source so the list can never drift. */
function declaredBuckets(): string[] {
  const src = read("lib/bookings/queue.ts");
  const at = src.indexOf("export type BookingBucket =");
  expect(at, "BookingBucket union not found — did it move?").toBeGreaterThan(-1);
  const decl = src.slice(at, src.indexOf(";", at));
  const found = [...decl.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  expect(found.length, "no bucket names parsed out of the union").toBeGreaterThan(3);
  return found;
}

describe("BookingBucket coverage", () => {
  it("every bucket is filtered into a section on /bookings", () => {
    const page = read("app/(dashboard)/bookings/page.tsx");
    const missing = declaredBuckets().filter((b) => !page.includes(`by("${b}")`));
    expect(
      missing,
      `these buckets classify rows that /bookings renders nowhere: ${missing.join(", ")}. ` +
        `A booking in an unrendered bucket is a real job with real money that appears on no screen — ` +
        `add a section for it, or do not classify into it.`,
    ).toEqual([]);
  });

  it("the money read on /payments Due covers the same buckets it lists", () => {
    // /payments deliberately lists FEWER sections than /bookings (it is the money
    // read, not the action queue), so this asserts the weaker property that
    // matters there: its headline is per-obligation via queueMoney, so no bucket
    // can be silently dropped from the TOTAL even when it has no section.
    const due = read("app/(dashboard)/payments/due-tab.tsx");
    expect(due).toContain("queueMoney(rows)");
    // A regression to per-bucket summing here would reintroduce QA-20260826-01
    // on the surface that reported it.
    expect(due).not.toMatch(/reduce\(\(s, r\) => s \+ r\.owed\.total, 0\)/);
  });
});
