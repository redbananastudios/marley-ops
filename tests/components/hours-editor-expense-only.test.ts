import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * An expense-only day is logged, not empty (QA-20260902-02).
 *
 * A crew member can save an expense (and receipt) with no start/finish times —
 * the actions layer documents that ordering as deliberate. The hours cell used
 * to fall through to the red "Add" prompt for such a day (identical to a
 * genuinely untouched one), and the week header tested hours and expenses
 * independently, printing the literal "Nothing logged yet · £4.20 expenses".
 *
 * Asserted as source guards per the tests/components house convention (vitest
 * runs `environment: 'node'`, no jsdom/RTL): the properties worth locking are
 * structural — the expense-only branch exists in the label ladder, it sits
 * BETWEEN "Unfinished" and the empty-day fallbacks, and the summary line's two
 * halves share one emptiness verdict instead of being tested apart.
 *
 * Every lookup goes through `at()`, which FAILS on a missing needle — a bare
 * indexOf returns -1 and orders "before" everything, which lets an ordering
 * assertion over two missing strings pass while proving nothing.
 */

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

const at = (haystack: string, needle: string, what: string): number => {
  const i = haystack.indexOf(needle);
  expect(i, `no longer contains ${what}`).toBeGreaterThan(-1);
  return i;
};

const SRC = read("components/my-jobs/hours-editor.tsx");

describe("the day cell's label ladder knows an expense-only day", () => {
  it("has an expense-only branch between Unfinished and the empty-day fallbacks", () => {
    // Ladder order is the guard: hours → unfinished → expense-only → future →
    // Add. The expense branch must sit AFTER "Unfinished" (times half-entered
    // still wins) and BEFORE the future/Add fallbacks, or an expense-only day
    // falls through to the untouched-day prompt again.
    const unfinished = at(SRC, '"block text-xs font-medium text-warn">Unfinished', "the Unfinished branch");
    const expenseOnly = at(SRC, "entry?.expense_amount != null || entry?.has_receipt ? (", "the expense-only branch");
    const future = at(SRC, "future ? (", "the future-day fallback");
    const add = at(SRC, '{week.lockedRef ? "—" : "Add"}', "the Add fallback");
    expect(unfinished).toBeLessThan(expenseOnly);
    expect(expenseOnly).toBeLessThan(future);
    expect(future).toBeLessThan(add);
  });

  it("labels it neutrally, not with the red needs-attention treatment", () => {
    // The branch body runs from its condition to the next `) :`. The label is
    // informational ("this day has content") — mist, not mm-red.
    const start = at(SRC, "entry?.expense_amount != null || entry?.has_receipt ? (", "the expense-only branch");
    const end = SRC.indexOf(") :", start);
    expect(end, "expense-only branch is not a ternary arm").toBeGreaterThan(start);
    const branch = SRC.slice(start, end);
    at(branch, "Expense only", "the expense-only label");
    expect(branch).not.toContain("text-mm-red");
  });

  it("checks the receipt too — a receipt can land before an amount is typed", () => {
    // The actions layer saves whatever's typed before uploading, so a row can
    // hold has_receipt with expense_amount null. Both halves of the check must
    // survive or that row regresses to "Add".
    const cond = "entry?.expense_amount != null || entry?.has_receipt";
    at(SRC, cond, "the two-part expense-only condition");
  });
});

describe("the week summary shares one emptiness verdict", () => {
  it("builds the line from parts and only says Nothing logged yet when there are none", () => {
    const parts = at(SRC, "const summaryParts = [", "the summaryParts builder");
    const hoursPart = at(SRC, "totalHours > 0 ? `${+totalHours.toFixed(2)} hrs` : null", "the hours part");
    const expensesPart = at(SRC, "totalExpenses > 0 ? `${gbp(totalExpenses)} expenses` : null", "the expenses part");
    const verdict = at(
      SRC,
      'summaryParts.length > 0 ? summaryParts.join(" · ") : "Nothing logged yet"',
      "the shared emptiness verdict",
    );
    expect(parts).toBeLessThan(hoursPart);
    expect(hoursPart).toBeLessThan(expensesPart);
    expect(expensesPart).toBeLessThan(verdict);
  });

  it("the old independent concatenation is gone", () => {
    // The bug's exact shape: "Nothing logged yet" gated on totalHours alone,
    // with the expenses clause appended regardless.
    expect(SRC).not.toContain('totalHours > 0 ? `${+totalHours.toFixed(2)} hrs` : "Nothing logged yet"');
    expect(SRC).not.toContain('totalExpenses > 0 ? ` · ${gbp(totalExpenses)} expenses` : ""');
  });
});
