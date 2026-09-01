import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Source guard over the gate 9b / 9c wiring.
 *
 * `lateBalanceDueAtAcceptance` and `payInFullAvailable` are pure and
 * unit-tested, and each can be perfectly correct while nothing calls it — or
 * while something calls straight past it. Those two failures are not equal:
 *
 *  - **A missed call site degrades to today.** The balance simply waits for the
 *    T-7 cron, as it always has. Annoying, not dangerous. `raisesOnEveryPath`
 *    catches it so a new accept path is not silently left behind.
 *  - **A call that bypasses a rule is the dangerous one.** Reaching
 *    `createBalanceInvoiceFlow` directly would raise a customer-facing invoice
 *    with none of the gates the rules exist to hold: the T-7 window, the
 *    cancelled/legacy locks, the ladder position, and above all the contract
 *    signature that stands in for `date_confirmed_at` at acceptance (Marks
 *    Davis MMR019 — never bill a date nobody agreed). `everyRaiseIsRuled` is
 *    the assertion that matters most in this file.
 *
 * It has already earned its keep once: gate 9c's `settleQuoteInFull` added the
 * second call site and this test failed on the spot, which is the point — a new
 * money path gets a deliberate decision rather than a silent addition.
 */
const SRC = readFileSync(join(process.cwd(), "lib/quote/accept-flow.ts"), "utf8");

const spanBetween = (from: string, to: string): string => {
  const start = SRC.indexOf(from);
  const end = SRC.indexOf(to, start);
  expect(start, `anchor not found: ${from}`).toBeGreaterThan(-1);
  expect(end, `anchor not found: ${to}`).toBeGreaterThan(start);
  return SRC.slice(start, end);
};

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

const ONLINE = spanBetween("export async function acceptQuoteOnline(", "/* ---------------");
const STAFF = spanBetween("export async function acceptQuoteByStaff(", "/* ---------------");

/** The two functions allowed to raise a balance from inside this module, each
 *  with the pure rule it must consult first. */
const RAISERS = [
  {
    fn: "export async function ensureLateBookingBalanceInvoice(",
    rule: "lateBalanceDueAtAcceptance(quote, !!signature)",
  },
  {
    fn: "export async function settleQuoteInFull(",
    rule: "payInFullAvailable(quote, lead)",
  },
] as const;

describe("gate 9b — the late-booking balance is raised on every accept path", () => {
  it("the span extraction found both accept functions, not an empty string", () => {
    // A renamed section comment would otherwise make every assertion below
    // vacuously true against an empty haystack.
    expect(ONLINE.length).toBeGreaterThan(2000);
    expect(STAFF.length).toBeGreaterThan(2000);
    expect(ONLINE).toContain("acceptQuoteOnline");
    expect(STAFF).toContain("acceptQuoteByStaff");
  });

  it("raisesOnEveryPath: both accept paths call it, at least as often as they raise a deposit invoice", () => {
    for (const [name, span] of [
      ["acceptQuoteOnline", ONLINE],
      ["acceptQuoteByStaff", STAFF],
    ] as const) {
      const late = count(span, "ensureLateBookingBalanceInvoice(sb,");
      const deposit = count(span, "ensureDepositInvoice(sb,");
      expect(late, `${name} never raises a late balance`).toBeGreaterThan(0);
      // Every place that ensures the deposit invoice is a place an acceptance
      // has just landed, so it is also a place the balance may be owed.
      expect(late, `${name} raises deposits on more paths than balances`).toBeGreaterThanOrEqual(
        deposit,
      );
    }
  });

  it("checks the rule against the real signature, not against `true`", () => {
    // The helper deliberately calls the rule twice: once with `true` to skip
    // the signature READ for a booking that cannot qualify anyway, then once
    // with the actual answer. Only the second decides.
    const helper = spanBetween(RAISERS[0].fn, "/* ---------------");
    expect(helper).toContain('.eq("kind", "contract")');
    expect(helper).toContain(RAISERS[0].rule);
    expect(helper.indexOf(RAISERS[0].rule)).toBeLessThan(
      helper.indexOf("await createBalanceInvoiceFlow("),
    );
  });
});

describe("every balance raise in this module is gated by a pure rule", () => {
  it("everyRaiseIsRuled: each call site sits behind its own rule, checked first", () => {
    for (const { fn, rule } of RAISERS) {
      const span = spanBetween(fn, "/* ---------------");
      expect(count(span, "await createBalanceInvoiceFlow("), `${fn} raises exactly once`).toBe(1);
      expect(span, `${fn} must consult ${rule}`).toContain(rule);
      expect(span.indexOf(rule), `${fn} must check its rule BEFORE raising`).toBeLessThan(
        span.indexOf("await createBalanceInvoiceFlow("),
      );
    }
  });

  it("and there are no OTHER call sites hiding in the module", () => {
    // One definition; one call per ruled raiser and not a single one more. A
    // third would mean a money path nobody gated. Bump this ONLY alongside a
    // new entry in RAISERS above — that is the deliberate decision this guard
    // exists to force.
    expect(count(SRC, "export async function createBalanceInvoiceFlow(")).toBe(1);
    expect(count(SRC, "await createBalanceInvoiceFlow(")).toBe(RAISERS.length);
  });
});

describe("gate 9b — the balance email never lies about an unpaid deposit", () => {
  it("sends the locally built HTML, not the hosted twin, when a deposit is outstanding", () => {
    // The hosted Resend template is a separately hand-written copy with no slot
    // for the outstanding deposit, so it would render "your deposit is already
    // accounted for" to the one customer that is wrong for (§11.7 trap 4).
    //
    // Whitespace-normalised, and the condition now carries a second exclusion:
    // COMMERCIAL. Same template, same trap one step further out — its hosted
    // copy asserts "payment in full is due before move day" throughout, so
    // rendering a completion invoice through it would restore in the template
    // exactly the claim the in-repo body stopped making. `!templateVars` is
    // that exclusion (balanceInvoiceTemplateVars returns null for commercial),
    // so this guard is now strictly stronger than the literal it replaces, not
    // relaxed to accommodate a reformat.
    const flat = SRC.replace(/\s+/g, " ");
    expect(flat).toContain(
      'const templateId = depositOutstanding > 0 || !templateVars ? null : templateIdFor(brand, "RESEND_TEMPLATE_BALANCE_INVOICE")',
    );
    // And the id is only ever USED with its vars, so a truthy id can never be
    // paired with a null variable set.
    expect(flat).toContain("...(templateId && templateVars");
  });

  it("derives the outstanding deposit from the quote, so every send path agrees", () => {
    // Raise, early raise, settle-in-full and office re-send all go through
    // sendBalanceInvoiceEmail.
    expect(SRC).toContain(
      "const depositOutstanding = quote.deposit_paid_at ? 0 : round2(Number(quote.deposit_amount ?? 0));",
    );
  });
});
