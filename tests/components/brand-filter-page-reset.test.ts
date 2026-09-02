import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Switching brand narrows the result set, so the page you were on may not
 * exist any more. The segmented control preserved every query param including
 * `?page=`, so /payments?page=2 + "Pitmans" sliced a 12-row result at offset
 * 50: "No payments in this range." under a count pill reading 12 and four
 * correct £ tiles, with the pager suppressed (pageCount === 1) so there was no
 * "← Newer" to escape by. A reader concludes no money landed.
 *
 * The tab and preset links in the same control row already drop `page`
 * deliberately — this is that rule, applied to the one scope change that
 * skipped it.
 */

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

const at = (haystack: string, needle: string, what: string): number => {
  const i = haystack.indexOf(needle);
  expect(i, `no longer contains ${what}`).toBeGreaterThan(-1);
  return i;
};

const SRC = read("components/brand/brand-filter.tsx");
const RECEIVED = read("app/(dashboard)/payments/received-tab.tsx");

describe("brand filter resets pagination", () => {
  it("drops the page param when the brand changes", () => {
    const select = at(SRC, "const select =", "the select handler");
    const replace = at(SRC, "router.replace(", "the navigation");
    const drop = SRC.indexOf('params.delete("page")', select);
    expect(drop, "the stale page param survives a brand switch").toBeGreaterThan(-1);
    expect(drop, "the reset must happen before the navigation").toBeLessThan(replace);
  });

  it("still preserves every other param", () => {
    // The `?brand=` param is the single source of truth and the URL stays
    // shareable — only the page offset is scope-dependent.
    at(SRC, "new URLSearchParams(searchParams.toString())", "the param carry-over");
  });

  it("targets the param the paginated tab actually reads", () => {
    at(RECEIVED, 'params.page ?? "1"', "the Received tab's page param (this test's premise)");
  });
});
