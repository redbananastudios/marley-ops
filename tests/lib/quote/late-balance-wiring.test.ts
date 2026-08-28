import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Source guard over the gate 9b wiring.
 *
 * `lateBalanceDueAtAcceptance` is pure and unit-tested, and it can be perfectly
 * correct while nothing calls it — or while something calls straight past it.
 * Those two failures are not equal:
 *
 *  - **A missed call site degrades to today.** The balance simply waits for the
 *    T-7 cron, as it always has. Annoying, not dangerous. `raisesOnEveryPath`
 *    below catches it so a new accept path is not silently left behind.
 *  - **A call that bypasses the rule is the dangerous one.** Reaching
 *    `createBalanceInvoiceFlow` directly from an accept path would raise a
 *    customer-facing invoice with none of the gates the rule exists to hold:
 *    the T-7 window, the cancelled/legacy locks, and above all the contract
 *    signature that stands in for `date_confirmed_at` (Marks Davis MMR019 —
 *    never bill a date nobody agreed). `onlyThroughTheRule` is the assertion
 *    that matters most in this file.
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

  it("onlyThroughTheRule: nothing in this module calls createBalanceInvoiceFlow except the guarded helper", () => {
    // One definition, one call. The call lives inside
    // ensureLateBookingBalanceInvoice, which is the only thing that consults
    // lateBalanceDueAtAcceptance. The office button and the T-7 cron call it
    // from their own modules, where their own guards apply.
    expect(count(SRC, "export async function createBalanceInvoiceFlow(")).toBe(1);
    expect(count(SRC, "await createBalanceInvoiceFlow(")).toBe(1);
    const helper = spanBetween(
      "export async function ensureLateBookingBalanceInvoice(",
      "/* ---------------",
    );
    expect(helper).toContain("await createBalanceInvoiceFlow(");
    expect(helper).toContain("lateBalanceDueAtAcceptance(");
  });

  it("checks the rule against the real signature, not against `true`", () => {
    // The helper deliberately calls the rule twice: once with `true` to skip
    // the signature READ for a booking that cannot qualify anyway, then once
    // with the actual answer. Only the second decides.
    const helper = spanBetween(
      "export async function ensureLateBookingBalanceInvoice(",
      "/* ---------------",
    );
    expect(helper).toContain('.eq("kind", "contract")');
    expect(helper).toContain("lateBalanceDueAtAcceptance(quote, !!signature)");
    // The signature check must sit BEFORE the raise, not after it.
    expect(helper.indexOf("lateBalanceDueAtAcceptance(quote, !!signature)")).toBeLessThan(
      helper.indexOf("await createBalanceInvoiceFlow("),
    );
  });
});

describe("gate 9b — the balance email never lies about an unpaid deposit", () => {
  it("sends the locally built HTML, not the hosted twin, when a deposit is outstanding", () => {
    // The hosted Resend template is a separately hand-written copy with no slot
    // for the outstanding deposit, so it would render "your deposit is already
    // accounted for" to the one customer that is wrong for (§11.7 trap 4).
    expect(SRC).toContain(
      'depositOutstanding > 0 ? null : templateIdFor(brand, "RESEND_TEMPLATE_BALANCE_INVOICE")',
    );
  });

  it("derives the outstanding deposit from the quote, so every send path agrees", () => {
    // Raise, early raise and office re-send all go through sendBalanceInvoiceEmail.
    expect(SRC).toContain(
      "const depositOutstanding = quote.deposit_paid_at ? 0 : round2(Number(quote.deposit_amount ?? 0));",
    );
  });
});
