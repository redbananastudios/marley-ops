import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UK_TZ } from "@/lib/uk-time";

/**
 * /s/<token> after signing is the customer's own receipt for a signed
 * agreement, so the date on it is a legal fact, not a formatting choice.
 *
 * `signed_at` is a timestamptz — the INSTANT of signing — while the page's
 * `prettyDay` helper slices the first ten characters and re-reads them as UTC
 * midnight. That is exact for `start_date` (a date COLUMN, no instant
 * involved) and wrong for an instant: a signature taken in the UK late evening
 * through BST falls on the previous UTC day, so the page told the customer
 * they signed the day before they did, while every office surface reading the
 * same column pins UK_TZ and showed the right one.
 */

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

const at = (haystack: string, needle: string, what: string): number => {
  const i = haystack.indexOf(needle);
  expect(i, `no longer contains ${what}`).toBeGreaterThan(-1);
  return i;
};

const SRC = read("app/s/[token]/page.tsx");

const long = { day: "numeric", month: "long", year: "numeric" } as const;

describe("the day a late-evening BST signature falls on", () => {
  // 00:20 on 2 September, UK. Stored as the UTC instant an hour earlier.
  const signedAt = "2026-09-01T23:20:00Z";

  it("is the day AFTER the UTC slice says", () => {
    const sliced = new Date(`${signedAt.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-GB", {
      ...long,
      timeZone: "UTC",
    });
    const uk = new Date(signedAt).toLocaleDateString("en-GB", { ...long, timeZone: UK_TZ });
    expect(sliced).toBe("1 September 2026");
    expect(uk).toBe("2 September 2026");
  });
});

describe("/s renders the signing date in UK time", () => {
  it("does not put the timestamptz through the date-column helper", () => {
    expect(SRC, "signed_at still goes through the UTC-midnight slice").not.toContain(
      "prettyDay(existing.signed_at)",
    );
  });

  it("formats the signing instant with the house timezone", () => {
    at(SRC, 'from "@/lib/uk-time"', "the uk-time import");
    const fmt = at(SRC, "prettyInstant", "the instant formatter");
    expect(SRC.indexOf("timeZone: UK_TZ", fmt), "the formatter does not pin UK_TZ").toBeGreaterThan(-1);
    at(SRC, "prettyInstant(existing.signed_at)", "the signing date call site");
  });

  it("leaves the date-column call sites alone", () => {
    // start_date IS a date column — UTC-midnight parsing is exact there, and
    // re-reading it as an instant would introduce the opposite error.
    at(SRC, "prettyDay(let_.start_date)", "the start-date call sites");
  });
});
