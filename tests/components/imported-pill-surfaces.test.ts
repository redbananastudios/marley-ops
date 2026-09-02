import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The Pitmans "Imported" pill marks a row whose booking was carried across
 * mid-flight from the previous diary (leads.source_system = 'pitmans') — the
 * office reads it as "comms locked, terms honoured, tread carefully". That is
 * a property of the ROW, not of how many brands are active:
 *
 *  - /bookings gated the whole source_system read on isMultiBrand(), so in
 *    single-brand mode imported rows rendered bare even though imported rows
 *    exist regardless of brand count.
 *  - /payments Due renders the same rows through the same money seam and had
 *    no Imported marker at all — the admin money read silently dropped the
 *    one signal that says "this row's money is handled outside the ladder".
 *
 * Source guards per the tests/components house convention (node env, no
 * jsdom): the properties worth locking are that each surface READS
 * source_system ungated by brand count and RENDERS the pill. at() fails on a
 * missing needle so an ordering assertion can never pass vacuously.
 */

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

const at = (haystack: string, needle: string, what: string): number => {
  const i = haystack.indexOf(needle);
  expect(i, `no longer contains ${what}`).toBeGreaterThan(-1);
  return i;
};

/** JSX renders the pill text on its own line — match across the whitespace. */
const atRe = (haystack: string, re: RegExp, what: string): number => {
  const m = re.exec(haystack);
  expect(m, `no longer contains ${what}`).not.toBeNull();
  return m!.index;
};

const IMPORTED_PILL = />\s*Imported\s*</;

describe("/payments Due carries the Imported marker", () => {
  const SRC = read("app/(dashboard)/payments/due-tab.tsx");

  it("reads source_system off the rows' leads", () => {
    at(SRC, "source_system", "the source_system read");
    at(SRC, "importedLeads", "the imported-leads set");
  });

  it("renders the Imported pill beside the Legacy one", () => {
    const legacy = at(SRC, "Legacy (iMVE)", "the legacy pill");
    const imported = atRe(SRC, IMPORTED_PILL, "the Imported pill");
    // Wording matches /bookings so the two office surfaces read as one system.
    at(SRC, "carried across mid-flight from the previous diary", "the Imported pill tooltip");
    expect(legacy).toBeLessThan(imported);
  });

  it("does not gate the leads read on a named brand filter", () => {
    // The read now runs for the pill whenever there are rows; only the row
    // NARROWING stays behind the filter. The old shape gated the entire read.
    expect(
      SRC.includes('if (brandFilter !== "all" && allRows.length)'),
      "the leads read is still gated on a named ?brand= — single-brand/All renders lose the Imported pill",
    ).toBe(false);
  });
});

describe("/bookings marks imported rows regardless of brand count", () => {
  const SRC = read("app/(dashboard)/bookings/page.tsx");

  it("no longer gates the source_system read on isMultiBrand", () => {
    at(SRC, "source_system", "the source_system read");
    expect(
      SRC.includes("if (multi && allRows.length)"),
      "the enrichment read is still gated on multi-brand — single-brand imported rows render bare",
    ).toBe(false);
  });

  it("still renders the Imported pill", () => {
    atRe(SRC, IMPORTED_PILL, "the Imported pill");
    at(SRC, "importedLeads.has(r.leadId)", "the per-row imported check");
  });
});
