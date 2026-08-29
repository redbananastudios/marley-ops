import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyBooking, moneyTileCounts, owedNow, type QueueSignals } from "@/lib/bookings/queue";

/**
 * Regression guard for QA-20260820-02: the dashboard's "Awaiting deposit" tile
 * counted leads with status='provisional' while /bookings counted accepted,
 * uncancelled quotes with the deposit unpaid — the two agreed only by
 * coincidence (the accept flow usually moves status and deposit together) and
 * split silently on any hand-confirmed lead with an unpaid deposit (staging
 * showed 1 vs 6). Both money tiles must come off the same classified ledger
 * the /bookings queue renders, never a lead-status proxy.
 *
 * And they must count OBLIGATIONS, not buckets. "Balance due" tested the two
 * balance_* buckets, which the ladder only reaches once the deposit is paid
 * and a removal appointment exists — so the card said "No balances
 * outstanding" against a live unpaid invoice on every shape that raises the
 * balance early, and against every commercial job, which enters no balance_*
 * bucket at all.
 */

const TODAY = "2026-08-20";
const AGREED = 1800;
const DEPOSIT = 100;

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

/** One ledger row exactly as loadBookingRows builds it — the same signals
 *  classified into a bucket AND priced into obligations, so a fixture can
 *  never claim a bucket its money contradicts. */
const row = (s: QueueSignals, balanceAmount = AGREED - DEPOSIT) => ({
  bucket: classifyBooking(s, TODAY),
  deposit: DEPOSIT,
  owed: owedNow(
    {
      commitmentInvoiceAmount: Number(s.commitmentInvoiceAmount ?? 0),
      commitmentPaidAt: s.commitmentPaidAt,
      commitmentDueDate: s.commitmentDueDate,
      dateReleasableAt: s.dateReleasableAt,
      balanceAmount,
      balancePaidAt: s.balancePaidAt,
      balanceInvoiceNumber: s.balanceInvoiceNumber,
      hasRemovalAppt: s.hasRemovalAppt,
      apptDayUk: s.apptDayUk,
      paymentPolicy: s.paymentPolicy,
      commercialDueDate: s.commercialDueDate,
    },
    TODAY,
  ),
});

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

  it("balanceDue counts money owed NOW — an all_set booking owes nothing yet", () => {
    const booked = { ...base, hasRemovalAppt: true };
    const rows = [
      row({ ...booked, apptDayUk: "2026-08-15" }), // move day passed, unpaid → owes the balance
      row({ ...booked, apptDayUk: "2026-08-22" }), // inside the invoice window → owes the balance
      row({ ...booked, apptDayUk: "2026-09-30" }), // far future, nothing owed yet
      row({ ...booked, apptDayUk: "2026-08-22", balancePaidAt: "2026-08-18T09:00:00Z" }), // settled
      row({ ...base, depositPaidAt: null }), // deposit rung, no balance owed
    ];
    expect(moneyTileCounts(rows)).toEqual({ awaitingDeposit: 1, balanceDue: 2 });
  });

  it("a late booking counts in BOTH tiles — it owes the deposit and the balance at once", () => {
    // Gate 9b: a move inside T-7 accepted online raises the balance invoice at
    // ACCEPTANCE, before the deposit lands and before the office allocates the
    // slot. The bucket ladder can only say `deposit_outstanding`, so the
    // bucket-tested tile read "No balances outstanding" over a live £1,700
    // invoice. The tiles are obligations; they do not partition.
    const late = row({
      ...base,
      depositPaidAt: null,
      hasRemovalAppt: false,
      balanceInvoiceNumber: "MM-2026-112-BAL",
    });
    expect(late.bucket).toBe("deposit_outstanding");
    expect(moneyTileCounts([late])).toEqual({ awaitingDeposit: 1, balanceDue: 1 });
  });

  it("counts a commercial completion invoice, which enters no balance_* bucket", () => {
    const commercial = row({
      ...base,
      depositPaidAt: null,
      paymentPolicy: "commercial",
      jobCompleted: true,
      hasRemovalAppt: true,
      apptDayUk: "2026-08-10",
      balanceInvoiceNumber: "MM-2026-113-BAL",
      commercialDueDate: "2026-09-09",
    });
    expect(commercial.bucket).toBe("commercial_invoiced");
    // No deposit on the commercial ladder, and the invoice is money owed today.
    expect(moneyTileCounts([commercial])).toEqual({ awaitingDeposit: 0, balanceDue: 1 });
  });

  it("counts nothing for no rows", () => {
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
