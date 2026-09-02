import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * /finance after the Zoho→Xero ledger flip — two declarations the page owes
 * its reader:
 *
 * 1. The split-ledger PARTIAL warning (fd2df91) landed on the quarter tile
 *    only. "Month so far" reads the same single-provider window, so a month
 *    straddling the cutover reported a partial figure as complete — worse
 *    than empty, because the number looks plausible. The month tile now
 *    carries the same historySplit declaration.
 *
 * 2. Error and degrade surfaces hardcoded "Zoho" — "Couldn't load the books
 *    from Zoho", "check Zoho", "Could not reach Zoho" — while the reads go
 *    through the configured provider. The #197 rule: name the ledger the
 *    failure actually came from, or the remedy's front door sends a human
 *    into the wrong system with a clear conscience. Labels now resolve off
 *    configuredProvider().
 */

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

const at = (haystack: string, needle: string, what: string): number => {
  const i = haystack.indexOf(needle);
  expect(i, `no longer contains ${what}`).toBeGreaterThan(-1);
  return i;
};

const SRC = read("app/(dashboard)/finance/page.tsx");

describe("/finance month tile declares the split-ledger PARTIAL state", () => {
  it("gates the month sub on historySplit like the quarter tile", () => {
    const month = at(SRC, 'label="Month so far"', "the month tile");
    const quarter = at(SRC, 'label="VAT quarter to date"', "the quarter tile");
    const monthSub = SRC.slice(month, quarter);
    expect(monthSub, "month tile must carry the historySplit declaration").toContain("historySplit");
    expect(monthSub, "the declaration must SAY it is partial").toContain("PARTIAL");
  });
});

describe("/finance error surfaces name the configured ledger", () => {
  it("derives a provider-aware ledger name", () => {
    at(SRC, "ledgerName", "the provider-aware ledger label");
  });

  it("no longer hardcodes Zoho into the failure card, the catch fallback or the cap warnings", () => {
    expect(SRC.includes("from Zoho</p>"), "the error card still says Zoho").toBe(false);
    expect(SRC.includes('"Could not reach Zoho."'), "the catch fallback still says Zoho").toBe(false);
    expect(SRC.includes("check Zoho"), "a truncation warning still says check Zoho").toBe(false);
    expect(SRC.includes("in Zoho`"), "the open-invoice aria-label still says Zoho").toBe(false);
  });
});
