import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyBooking, moneyTileCounts, type BookingBucket, type QueueSignals } from "@/lib/bookings/queue";

/**
 * Regression guard for QA-20260820-02: the dashboard's "Awaiting deposit" tile
 * counted leads with status='provisional' while /bookings counted accepted,
 * uncancelled quotes with the deposit unpaid — the two agreed only by
 * coincidence (the accept flow usually moves status and deposit together) and
 * split silently on any hand-confirmed lead with an unpaid deposit (staging
 * showed 1 vs 6). Both money tiles must come off the same classified ledger
 * the /bookings queue renders, never a lead-status proxy.
 */

const TODAY = "2026-08-20";

const base: QueueSignals = {
  depositPaidAt: "2026-08-01T10:00:00Z",
  hasRemovalAppt: false,
  apptDayUk: null,
  provisionalDate: null,
  approxWindow: null,
  approxMonth: null,
  commitmentPaidAt: null,
  commitmentInvoiceAmount: null,
  commitmentDueDate: null,
  dateReleasableAt: null,
  balancePaidAt: null,
  balanceInvoiceNumber: null,
};

const row = (s: QueueSignals): { bucket: BookingBucket } => ({ bucket: classifyBooking(s, TODAY) });

describe("moneyTileCounts", () => {
  it("counts every deposit_outstanding row, including the hand-confirmed shape that split the surfaces", () => {
    // The exact staging divergence: leads already past 'provisional' (even with
    // a removal appointment booked) whose deposit is still unpaid. The status
    // proxy missed all of these; the ledger count must not.
    const rows = [
      row({ ...base, depositPaidAt: null }), // freshly accepted, no diary entry
      row({ ...base, depositPaidAt: null, hasRemovalAppt: true, apptDayUk: "2026-08-20" }), // hand-confirmed, moving today
      row({ ...base, depositPaidAt: null, hasRemovalAppt: true, apptDayUk: "2026-09-04" }),
    ];
    expect(moneyTileCounts(rows).awaitingDeposit).toBe(3);
  });

  it("balanceDue counts balance_due + balance_overdue only — an all_set booking owes nothing yet", () => {
    const booked = { ...base, hasRemovalAppt: true };
    const rows = [
      row({ ...booked, apptDayUk: "2026-08-15" }), // move day passed, unpaid → balance_overdue
      row({ ...booked, apptDayUk: "2026-08-22" }), // inside the invoice window → balance_due
      row({ ...booked, apptDayUk: "2026-09-30" }), // far future, nothing owed → all_set
      row({ ...booked, apptDayUk: "2026-08-22", balancePaidAt: "2026-08-18T09:00:00Z" }), // settled
      row({ ...base, depositPaidAt: null }), // deposit rung, not a balance rung
    ];
    expect(moneyTileCounts(rows)).toEqual({ awaitingDeposit: 1, balanceDue: 2 });
  });

  it("a booking lands in exactly one tile — the buckets partition, never double-count", () => {
    const everyShape = [
      row({ ...base, depositPaidAt: null }),
      row(base),
      row({ ...base, provisionalDate: "2026-09-01" }),
      row({ ...base, hasRemovalAppt: true, apptDayUk: "2026-08-15" }),
      row({ ...base, hasRemovalAppt: true, apptDayUk: "2026-09-30" }),
    ];
    const { awaitingDeposit, balanceDue } = moneyTileCounts(everyShape);
    expect(awaitingDeposit + balanceDue).toBeLessThanOrEqual(everyShape.length);
    expect(moneyTileCounts([])).toEqual({ awaitingDeposit: 0, balanceDue: 0 });
  });
});

describe("dashboard money tiles read the /bookings ledger (source contract)", () => {
  const ROOT = resolve(__dirname, "../..");
  const src = readFileSync(join(ROOT, "app/(dashboard)/page.tsx"), "utf8");

  it("awaitingDeposit is never the status='provisional' proxy", () => {
    // The original bug: a lead can sit at any status while its accepted
    // quote's deposit is unpaid, so counting a status is counting the wrong
    // table. If the tile needs a new source, it must still be the classified
    // booking ledger, not leads.status.
    expect(src, "awaitingDeposit must count the deposit_outstanding bucket, not leads.status='provisional'").not.toMatch(
      /awaitingDeposit:\s*statusCounts/,
    );
  });

  it("the tiles consume loadBookingRows + moneyTileCounts — the same ledger /bookings renders", () => {
    expect(src).toMatch(/loadBookingRows\(/);
    expect(src).toMatch(/moneyTileCounts\(/);
  });
});
