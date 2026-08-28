import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { balanceInvoiceDue } from "@/lib/payments/balance-invoice-due";

/**
 * "Commercial is excluded from the chase engine entirely" (PRD §3.10), and
 * since 2026-08-28 its invoices are raised BY HAND on completion — so nothing
 * automatic may email a commercial customer about money, and nothing automatic
 * may raise its invoice.
 *
 * The chase cron has FIVE stages that reach a customer or an alarm, each with
 * its own quotes query. An exclusion added to one and missed in another is
 * silent, which is why this is a source guard and not four behaviour tests: it
 * fails when a SIXTH stage arrives without one.
 */

const CRON = readFileSync(join(process.cwd(), "app/api/cron/chase/route.ts"), "utf8");

/** The cron with `//` comment lines stripped. A guard must assert on CODE:
 *  the first version of the .neq assertion below matched the comment that
 *  explains why not to use .neq, and failed on a correct file. */
const CODE = CRON.split("\n")
  .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
  .join("\n");

describe("every chase stage excludes commercial", () => {
  it("the shared quote array is filtered once, covering quote + deposit chases", () => {
    // Both stages read allQuotes via pickQuote, so one filter is the whole
    // exclusion for two of the five.
    expect(CRON).toContain('policyOfQuote(q as { payment_policy?: string | null }) !== "commercial"');
  });

  it("filters in CODE, never as a .neq on the query", () => {
    // In Postgres a NOT-EQUAL also drops NULLs, and payment_policy is NULL on
    // every UNACCEPTED quote — exactly the population the quote chase exists to
    // chase. `.neq("payment_policy","commercial")` would have silently stopped
    // chasing every unaccepted residential quote, which is a revenue bug that
    // looks like nothing at all.
    expect(CODE).not.toMatch(/neq\(\s*"payment_policy"/);
  });

  it("the post-move sweep and the commitment ladder each skip commercial", () => {
    const skips = CRON.split('policyOfQuote(q) === "commercial") continue;').length - 1;
    expect(
      skips,
      "post-move sweep and commitment ladder must each carry their own skip",
    ).toBe(2);
  });

  it("every quotes query in the cron selects payment_policy", () => {
    // A stage that filters on a column it did not select compares against
    // undefined — false on every row, silently, which is the failure this whole
    // file exists to prevent.
    const selects = CRON.match(/"id, [^"]*"/g) ?? [];
    const quoteSelects = selects.filter((sel) => sel.includes("quote_ref"));
    expect(quoteSelects.length, "expected the cron's quote selects").toBeGreaterThanOrEqual(3);
    for (const sel of quoteSelects) {
      expect(sel, `this quotes select omits payment_policy: ${sel.slice(0, 70)}...`).toContain(
        "payment_policy",
      );
    }
  });
});

describe("the T-7 balance raise refuses commercial", () => {
  // A residential booking that IS due, so the commercial case differs by one
  // field and nothing else.
  const TODAY = "2026-09-01";
  const T7 = "2026-09-08";
  const quote = {
    source: null,
    standard_comms_at: null,
    payment_policy: null as string | null,
    status: "accepted",
    moving_date: "2026-09-05",
    zoho_balance_invoice_id: null,
    booking_cancelled_at: null,
  };
  const lead = {
    status: "confirmed",
    balance_paid_at: null,
    date_confirmed_at: "2026-08-20T10:00:00Z",
  };

  it("a residential quote inside T-7 is still due", () => {
    // The control. This rule's existing behaviour must not move.
    expect(balanceInvoiceDue(quote, lead, TODAY, T7)).toBe(true);
  });

  it("a commercial quote is never queued, however close the move", () => {
    // Commercial invoices are raised by hand on completion. Automating one at
    // T-7 would create AND EMAIL a full-price invoice a week before the move,
    // on a booking the office is going to invoice itself - two invoices for one
    // job, and the customer holding the one nobody meant to send.
    expect(balanceInvoiceDue({ ...quote, payment_policy: "commercial" }, lead, TODAY, T7)).toBe(
      false,
    );
  });

  it("an absent policy is residential, matching every other reader", () => {
    expect(balanceInvoiceDue({ ...quote, payment_policy: null }, lead, TODAY, T7)).toBe(true);
    expect(balanceInvoiceDue({ ...quote, payment_policy: "residential" }, lead, TODAY, T7)).toBe(
      true,
    );
  });
});
