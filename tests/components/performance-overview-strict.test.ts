import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * /performance runs three tabs off the same rule (mirrors /storage, gate 12):
 * under a named ?brand= a partially-fetched window renders a wrong-narrowed
 * report that LOOKS complete, so paged reads fail LOUD then and keep their
 * fail-soft only on All. The sales and storage tabs both pass
 * `{ strict: brandFilter !== "all" }`; the Overview tab's leads + quotes
 * fetchAllRows calls passed nothing — so a failed later window under a filter
 * rendered a partial month total as complete.
 */

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

const at = (haystack: string, needle: string, what: string): number => {
  const i = haystack.indexOf(needle);
  expect(i, `no longer contains ${what}`).toBeGreaterThan(-1);
  return i;
};

const spanOf = (src: string, from: string, to: string): string => {
  const start = src.indexOf(from);
  expect(start, `anchor not found: ${from}`).toBeGreaterThan(-1);
  const end = src.indexOf(to, start);
  expect(end, `anchor not found: ${to}`).toBeGreaterThan(start);
  return src.slice(start, end);
};

const SRC = read("app/(dashboard)/performance/page.tsx");
// The Overview tab is the default export's body, after the two tab pages.
const OVERVIEW = spanOf(SRC, "export default async function PerformancePage", "aggregateEstimators");

describe("/performance Overview pages strictly under a named brand filter", () => {
  it("derives the same strict flag as the sales/storage tabs", () => {
    at(OVERVIEW, 'strict: brandFilter !== "all"', "the strict flag");
  });

  it("passes it to both unbounded paged reads", () => {
    const leads = at(OVERVIEW, 'from("leads").select("id, name, status, referral_commission")', "the leads paged read");
    const quotes = at(
      OVERVIEW,
      'from("quotes").select("lead_id, status, agreed_price, grand_total, booking_cancelled_at")',
      "the quotes paged read",
    );
    // Each read's fetchAllRows call carries the strict option — the flag must
    // appear within the call itself (a short window past the select), not just
    // somewhere in the file.
    expect(OVERVIEW.slice(leads, leads + 200), "leads read must carry strict").toContain("strict");
    expect(OVERVIEW.slice(quotes, quotes + 200), "quotes read must carry strict").toContain("strict");
  });
});
