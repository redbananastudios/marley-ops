import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi, beforeEach } from "vitest";

const { reportOperationalIssue, resolveOperationalIssue } = vi.hoisted(() => ({
  reportOperationalIssue: vi.fn(),
  resolveOperationalIssue: vi.fn(),
}));
vi.mock("@/lib/ops/issues", () => ({ reportOperationalIssue, resolveOperationalIssue }));

import {
  INVOICE_RAISE_ISSUE_KEY,
  reportInvoiceRaiseFailed,
  resolveInvoiceRaiseFailed,
} from "@/lib/ops/invoice-raise";

/**
 * 2026-08-28: four invoice raises failed inside the hour on Zoho's "exceeded
 * the maximum call rate limit of 1,000". Each wrote its message to the quote's
 * own `zoho_<kind>_error` column and emailed ops per quote, and that was the
 * whole record — `operational_issues` held nothing newer than 2026-08-20, no
 * screen renders those columns, and four customers went unbilled behind a green
 * board. These tests pin the alarm, and pin that it stays ONE alarm.
 */

const RATE_LIMIT = "The API call for this organisation has exceeded the maximum call rate limit of 1,000";

/** Supabase double for the single outstanding-errors read the resolve makes. */
function fakeSb(result: { data?: unknown[] | null; error?: { message: string } | null }) {
  const sb = {
    from: () => ({
      select: () => {
        const b: Record<string, unknown> = {};
        b.or = () => b;
        b.limit = () => Promise.resolve({ data: result.data ?? null, error: result.error ?? null });
        return b;
      },
    }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return sb as any;
}

describe("reportInvoiceRaiseFailed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("collapses every quote and every rung onto ONE key — ten failures are one alarm", async () => {
    const sb = fakeSb({ data: [] });
    await reportInvoiceRaiseFailed(sb, { message: RATE_LIMIT, kind: "deposit", quoteRef: "MMR112" });
    await reportInvoiceRaiseFailed(sb, { message: RATE_LIMIT, kind: "commitment", quoteRef: "MMR115" });
    await reportInvoiceRaiseFailed(sb, { message: RATE_LIMIT, kind: "balance", quoteRef: "MMR118" });

    // A key that varied by quote ref or by rung would upsert three rows, and the
    // office would read three unrelated incidents instead of one rate limit.
    expect(reportOperationalIssue).toHaveBeenCalledTimes(3);
    expect(new Set(reportOperationalIssue.mock.calls.map((c) => c[1].key))).toEqual(
      new Set([INVOICE_RAISE_ISSUE_KEY]),
    );
  });

  it("says the customer is unbilled and what to do, and keeps the per-quote detail in context", async () => {
    await reportInvoiceRaiseFailed(fakeSb({ data: [] }), {
      message: RATE_LIMIT,
      kind: "deposit",
      quoteRef: "MMR112",
      reference: "MMR112-DEP",
    });

    const issue = reportOperationalIssue.mock.calls[0][1];
    expect(issue.severity).toBe("error");
    expect(issue.source).toBe("ledger");
    expect(issue.event).toBe("ledger.invoice_raise_failed");
    // The digest shows the message and nothing else, so it has to carry the
    // consequence and the action on its own.
    expect(issue.message).toContain("not been billed");
    expect(issue.message).toContain("re-raise");
    // The quote-shaped facts still travel, just not in the dedupe key.
    expect(issue.context).toMatchObject({
      ledgerError: RATE_LIMIT,
      invoiceKind: "deposit",
      quoteRef: "MMR112",
      reference: "MMR112-DEP",
    });
  });
});

describe("resolveInvoiceRaiseFailed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("clears the alarm once no quote carries a raise error", async () => {
    await resolveInvoiceRaiseFailed(fakeSb({ data: [] }));
    expect(resolveOperationalIssue).toHaveBeenCalledWith(expect.anything(), INVOICE_RAISE_ISSUE_KEY);
  });

  it("leaves it standing while another quote is still unbilled", async () => {
    // One customer's deposit invoice going through says nothing about the next
    // customer's. Nothing renders zoho_<kind>_error, so clearing here would put
    // that quote back behind a green board — the silence this alarm broke.
    await resolveInvoiceRaiseFailed(fakeSb({ data: [{ id: "q-still-failing" }] }));
    expect(resolveOperationalIssue).not.toHaveBeenCalled();
  });

  it("leaves it standing when the check itself failed — could not check is not all clear", async () => {
    await resolveInvoiceRaiseFailed(fakeSb({ data: null, error: { message: "column does not exist" } }));
    expect(resolveOperationalIssue).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------- wiring guard over the rails */

/**
 * The reporter can be perfectly correct while nothing calls it, which is exactly
 * the state the rails were in: each raise handled `isLedgerAccessDenied` and let
 * every other failure fall through to an email only. This guard makes a new
 * money rail that alerts only on a lock-out fail here rather than in production.
 */
const SRC = readFileSync(join(process.cwd(), "lib/quote/accept-flow.ts"), "utf8");
const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

describe("every invoice rail reports a non-lock-out failure", () => {
  it("the source was actually read, not an empty string", () => {
    // Otherwise every count below is vacuously zero and matches zero.
    expect(SRC.length).toBeGreaterThan(10_000);
    expect(SRC).toContain("export async function ensureDepositInvoice(");
  });

  it("pairs a reportInvoiceRaiseFailed with every raise-side reportZohoAccessDenied", () => {
    // The lock-out branch and the everything-else branch are the two halves of
    // one catch. A rail that has only the first half is silent for rate limits,
    // validation errors and outages — the 2026-08-28 shape.
    //
    // Counted on `message: msg`, which is what a RAISE catch passes: the
    // payment-status watch reports a lock-out too, but it reads invoices rather
    // than creating them, so it has no unraised invoice to report.
    const lockout = count(SRC, 'reportZohoAccessDenied(sb, { message: msg, while: "');
    const other = count(SRC, "reportInvoiceRaiseFailed(sb,");
    expect(lockout).toBe(3); // deposit, commitment, balance
    expect(other).toBe(lockout);
  });

  it("names each rail, so a renamed kind cannot silently drop one", () => {
    // Matched on the whole call, not on `kind: "<x>"` alone: `paymentPush` already
    // carries a `kind: "deposit"` and a `kind: "balance"` of its own, so the bare
    // literal would have passed for two of the three rails while they reported
    // nothing at all.
    for (const kind of ["deposit", "commitment", "balance"]) {
      expect(SRC, `${kind} rail does not report a raise failure`).toContain(
        `reportInvoiceRaiseFailed(sb, { message: msg, kind: "${kind}"`,
      );
    }
  });
});
