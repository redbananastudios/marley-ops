import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakePostgrest } from "../bookings/fake-postgrest";

/**
 * Commercial credit control (PRD §3.10) — the alarm that exists BECAUSE the
 * customer is never chased.
 *
 * "No automated chase" means the customer is not emailed, not that nobody
 * notices. Until this sweep, an unpaid commercial invoice was visible only to
 * whoever opened /bookings and read to the bottom, and an invoice nobody opens
 * ages indefinitely while every surface stays green.
 *
 * A real behaviour test rather than a source guard: the sweep is a pure
 * decision over classified rows, and what matters is WHICH alarm fires, that a
 * clean read clears one, and — the case that has actually bitten this codebase
 * repeatedly — that a FAILED read clears nothing.
 */

const loadBookingRows = vi.fn();
const reportOperationalIssue = vi.fn();
const resolveOperationalIssue = vi.fn();

vi.mock("@/lib/bookings/load-signals", () => ({
  loadBookingRows: (...args: unknown[]) => loadBookingRows(...args),
}));
// The REAL loader, kept beside the mock: the last block below drives it with a
// database error injected, which is the only shape that reproduces the defect
// these tests are written against (see "the real loader" below).
const realLoadSignals = await vi.importActual<typeof import("@/lib/bookings/load-signals")>(
  "@/lib/bookings/load-signals",
);
vi.mock("@/lib/ops/issues", () => ({
  reportOperationalIssue: (...args: unknown[]) => reportOperationalIssue(...args),
  resolveOperationalIssue: (...args: unknown[]) => resolveOperationalIssue(...args),
}));
vi.mock("@/lib/log", () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const {
  sweepCommercialOverdue,
  COMMERCIAL_OVERDUE_ISSUE_KEY,
  COMMERCIAL_TERMS_MISSING_ISSUE_KEY,
} = await import("@/lib/ops/commercial-overdue");

const sb = {} as never;
const row = (quoteRef: string, bucket: string) => ({ quoteRef, bucket });
const keysReported = () => reportOperationalIssue.mock.calls.map((c) => c[1].key);
const keysResolved = () => resolveOperationalIssue.mock.calls.map((c) => c[1]);
const reportFor = (key: string) =>
  reportOperationalIssue.mock.calls.find((c) => c[1].key === key)?.[1];

beforeEach(() => {
  loadBookingRows.mockReset();
  reportOperationalIssue.mockReset();
  resolveOperationalIssue.mockReset();
});

describe("an overdue commercial invoice raises an internal alarm", () => {
  it("reports the overdue key, with the refs and the count", async () => {
    loadBookingRows.mockResolvedValue({
      rows: [
        row("MMC001", "commercial_overdue"),
        row("MMC002", "commercial_overdue"),
        row("MMR003", "balance_due"),
      ],
      todayUk: "2026-08-28",
    });

    const sweep = await sweepCommercialOverdue(sb);

    expect(sweep).toEqual({ overdue: ["MMC001", "MMC002"], termsMissing: [], checked: true });
    const issue = reportFor(COMMERCIAL_OVERDUE_ISSUE_KEY);
    expect(issue).toBeDefined();
    expect(issue.context).toEqual({ count: 2, quoteRefs: ["MMC001", "MMC002"] });
    // Never the customer. The whole point of the alarm is that this ladder has
    // no chase — an alert that emailed them would reverse the decision.
    expect(issue.source).toBe("commercial");
    expect(issue.message).toContain("never chased by email");
    // One alarm for the credit-control job, not one per invoice: five separate
    // alarms read as five unrelated incidents and bury the single remedy.
    expect(keysReported().filter((k) => k === COMMERCIAL_OVERDUE_ISSUE_KEY)).toHaveLength(1);
  });

  it("clears the alarm when nothing is overdue", async () => {
    loadBookingRows.mockResolvedValue({
      rows: [row("MMC001", "commercial_invoiced"), row("MMC002", "all_set")],
      todayUk: "2026-08-28",
    });

    const sweep = await sweepCommercialOverdue(sb);

    expect(sweep.overdue).toEqual([]);
    expect(keysReported()).toEqual([]);
    expect(keysResolved()).toContain(COMMERCIAL_OVERDUE_ISSUE_KEY);
  });
});

describe("an invoice with no terms date gets its own alarm", () => {
  it("reports it separately — the overdue rule can never fire for it", async () => {
    // This is the hole in alarm 1. `commercial_terms_unknown` means the invoice
    // has no due date, so no rule can ever call it late: it would sit unpaid
    // forever without the overdue alarm ever having anything to say. The
    // remedy is different too — set the terms, not chase the client.
    loadBookingRows.mockResolvedValue({
      rows: [row("MMC004", "commercial_terms_unknown")],
      todayUk: "2026-08-28",
    });

    const sweep = await sweepCommercialOverdue(sb);

    expect(sweep.termsMissing).toEqual(["MMC004"]);
    expect(sweep.overdue).toEqual([]);
    const issue = reportFor(COMMERCIAL_TERMS_MISSING_ISSUE_KEY);
    expect(issue).toBeDefined();
    expect(issue.message).toContain("nothing can ever say it is late");
    // The overdue alarm must NOT fire for it — that would be a claim of fact
    // about a date that does not exist.
    expect(keysReported()).not.toContain(COMMERCIAL_OVERDUE_ISSUE_KEY);
    expect(keysResolved()).toContain(COMMERCIAL_OVERDUE_ISSUE_KEY);
  });

  it("counts the two buckets separately rather than summing them", async () => {
    loadBookingRows.mockResolvedValue({
      rows: [
        row("MMC005", "commercial_overdue"),
        row("MMC006", "commercial_terms_unknown"),
        row("MMC007", "commercial_terms_unknown"),
      ],
      todayUk: "2026-08-28",
    });

    const sweep = await sweepCommercialOverdue(sb);

    expect(sweep.overdue).toEqual(["MMC005"]);
    expect(sweep.termsMissing).toEqual(["MMC006", "MMC007"]);
    expect(reportFor(COMMERCIAL_OVERDUE_ISSUE_KEY).context.count).toBe(1);
    expect(reportFor(COMMERCIAL_TERMS_MISSING_ISSUE_KEY).context.count).toBe(2);
  });
});

describe("a failed read clears nothing", () => {
  it("returns checked:false and resolves neither alarm", async () => {
    // The failure this whole file is written against: a sweep that could not
    // read has NOT found nothing. Resolving on a read that threw would green
    // the board on an answer we never got, and the surface that would have
    // shown the discrepancy is the one the resolve just cleared.
    loadBookingRows.mockRejectedValue(new Error("PostgREST unreachable"));

    const sweep = await sweepCommercialOverdue(sb);

    expect(sweep).toEqual({ overdue: [], termsMissing: [], checked: false });
    expect(resolveOperationalIssue).not.toHaveBeenCalled();
    expect(reportOperationalIssue).not.toHaveBeenCalled();
  });

  it("the real loader, with a real database error, reaches the sweep as a failure", async () => {
    // The two tests above use `mockRejectedValue`, and a rejection is the ONE
    // failure the real loader cannot produce: supabase-js resolves with
    // `{data:null,error}`, fetchAllRows logs the window and breaks, and the
    // secondary reads destructure only `data`. So the guarantee they assert was
    // never actually held — a broken read arrived here as `rows: []`, took both
    // `else` branches, and resolved two live commercial alarms while reporting
    // `checked: true`. This drives the loader itself, with the error injected
    // where PostgREST puts it.
    loadBookingRows.mockImplementation(realLoadSignals.loadBookingRows);
    const broken = fakePostgrest({
      business_settings: { data: null, error: null },
      quotes: {
        data: null,
        error: { message: "column quotes.commercial_due_date does not exist" },
      },
    });

    const sweep = await sweepCommercialOverdue(broken);

    expect(sweep).toEqual({ overdue: [], termsMissing: [], checked: false });
    expect(resolveOperationalIssue).not.toHaveBeenCalled();
    expect(reportOperationalIssue).not.toHaveBeenCalled();
  });

  it("its empty arrays are not the same answer as a clean sweep's", async () => {
    // Both return `overdue: []`. Only `checked` separates "nothing is overdue"
    // from "I could not tell whether anything is overdue", which is why the
    // caller keys off it rather than off the array length.
    loadBookingRows.mockRejectedValue(new Error("boom"));
    const failed = await sweepCommercialOverdue(sb);

    loadBookingRows.mockResolvedValue({ rows: [], todayUk: "2026-08-28" });
    const clean = await sweepCommercialOverdue(sb);

    expect(failed.overdue).toEqual(clean.overdue);
    expect(failed.checked).toBe(false);
    expect(clean.checked).toBe(true);
  });
});
