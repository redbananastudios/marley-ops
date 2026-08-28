import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyBooking, owedNow, type BookingBucket, type QueueSignals } from "@/lib/bookings/queue";
import { moneySectionsOf, type MoneySectionRow } from "@/lib/bookings/sections";

/**
 * Every BookingBucket must be rendered by some section of /bookings.
 *
 * The type system cannot enforce this. Adding a bucket to the union compiles
 * cleanly, and any booking that classifies into it renders on no screen at
 * all. Silent, and invisible in exactly the way that matters: the row is a
 * real job with real money against it.
 *
 * This bit for real once already, one layer down: `/bookings` hid the
 * commitment queues behind a booked diary slot, so a date-confirmed job that
 * was never put in the diary had its 25% invoice on no screen (the reason
 * `payments-card.tsx` grew a commitment cell, and half of QA-20260826-01).
 *
 * The page now dispatches TWO ways, so the guard checks both:
 *   - lifecycle rungs are still filtered by name — `by("no_date")`;
 *   - money rungs are filtered by OBLIGATION off lib/bookings/sections.ts,
 *     where the bucket name need never appear.
 * So a representative row is built for every declared bucket (by running the
 * real classifier, which is what stops the fixture drifting from the rule) and
 * has to land in one mechanism or the other. A source scan alone would now
 * report the money buckets as homeless while they render perfectly; an
 * obligation check alone would miss the lifecycle rungs, which owe nothing.
 */

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

/** The union members, read from the source so the list can never drift. */
function declaredBuckets(): string[] {
  const src = read("lib/bookings/queue.ts");
  const at = src.indexOf("export type BookingBucket =");
  expect(at, "BookingBucket union not found — did it move?").toBeGreaterThan(-1);
  const decl = src.slice(at, src.indexOf(";", at));
  const found = [...decl.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  expect(found.length, "no bucket names parsed out of the union").toBeGreaterThan(3);
  return found;
}

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

const commercial: Partial<QueueSignals> = {
  depositPaidAt: null,
  paymentPolicy: "commercial",
  jobCompleted: true,
  hasRemovalAppt: true,
  apptDayUk: "2026-08-01",
};

/** One set of signals per bucket. A new bucket with no entry here fails the
 *  first test below, which is the point: it cannot be added without someone
 *  saying what a row in it looks like and where it renders. */
const SIGNALS: Record<string, Partial<QueueSignals>> = {
  deposit_outstanding: { depositPaidAt: null },
  no_date: {},
  provisional: { provisionalDate: "2026-09-10" },
  commitment_overdue: {
    hasRemovalAppt: true,
    apptDayUk: "2026-09-10",
    commitmentInvoiceAmount: 450,
    commitmentDueDate: "2026-08-10",
  },
  commitment_due: {
    hasRemovalAppt: true,
    apptDayUk: "2026-09-10",
    commitmentInvoiceAmount: 450,
    commitmentDueDate: "2026-08-30",
  },
  balance_overdue: { hasRemovalAppt: true, apptDayUk: "2026-08-15" },
  balance_due: { hasRemovalAppt: true, apptDayUk: "2026-08-24" },
  commercial_awaiting_completion: { ...commercial },
  commercial_invoiced: { ...commercial, balanceInvoiceNumber: "MM-BAL", commercialDueDate: "2026-09-30" },
  commercial_overdue: { ...commercial, balanceInvoiceNumber: "MM-BAL", commercialDueDate: "2026-08-10" },
  // Invoiced, no terms date. The other two commercial rows differ from this one
  // ONLY in carrying a date, which is the distinction the bucket exists to
  // make: without it this row classified `commercial_invoiced` and rendered as
  // reassuringly in-terms on the strength of knowing nothing.
  commercial_terms_unknown: { ...commercial, balanceInvoiceNumber: "MM-BAL", commercialDueDate: null },
  all_set: { hasRemovalAppt: true, apptDayUk: "2026-10-30" },
};

function rowFor(bucket: string): MoneySectionRow {
  const sig: QueueSignals = { ...base, ...SIGNALS[bucket] };
  const classified = classifyBooking(sig, TODAY);
  expect(classified, `the fixture for "${bucket}" no longer classifies into it`).toBe(bucket as BookingBucket);
  return {
    bucket: classified,
    paymentPolicy: sig.paymentPolicy === "commercial" ? "commercial" : "residential",
    deposit: 100,
    owed: owedNow(
      {
        commitmentInvoiceAmount: Number(sig.commitmentInvoiceAmount ?? 0),
        commitmentPaidAt: sig.commitmentPaidAt,
        commitmentDueDate: sig.commitmentDueDate,
        dateReleasableAt: sig.dateReleasableAt,
        balanceAmount: 1500,
        balancePaidAt: sig.balancePaidAt,
        balanceInvoiceNumber: sig.balanceInvoiceNumber,
        hasRemovalAppt: sig.hasRemovalAppt,
        apptDayUk: sig.apptDayUk,
        paymentPolicy: sig.paymentPolicy,
        commercialDueDate: sig.commercialDueDate,
      },
      TODAY,
    ),
  };
}

describe("BookingBucket coverage", () => {
  it("every declared bucket has a representative row", () => {
    const missing = declaredBuckets().filter((b) => !SIGNALS[b]);
    expect(
      missing,
      `no fixture describes a booking in: ${missing.join(", ")}. Add one, and say which section renders it.`,
    ).toEqual([]);
  });

  it("every bucket is rendered by /bookings — by name, or by the money it owes", () => {
    const page = read("app/(dashboard)/bookings/page.tsx");
    const missing = declaredBuckets().filter(
      (b) => !page.includes(`by("${b}")`) && moneySectionsOf(rowFor(b)).length === 0,
    );
    expect(
      missing,
      `these buckets classify rows that /bookings renders nowhere: ${missing.join(", ")}. ` +
        `A booking in an unrendered bucket is a real job with real money that appears on no screen — ` +
        `give it a lifecycle section (filtered by name) or a money section (lib/bookings/sections.ts), ` +
        `or do not classify into it.`,
    ).toEqual([]);
  });

  it("/payments Due renders the same money seam, so no obligation is dropped from its total", () => {
    // /payments deliberately lists FEWER lifecycle sections than /bookings (it
    // is the money read, not the action queue). What it may never do is print
    // section totals that do not reach the headline above them, which is what
    // bucket-filtered lists did: the per-obligation headline counted a gate 9b
    // late booking's balance and no section on the page held it.
    const due = read("app/(dashboard)/payments/due-tab.tsx");
    expect(due).toContain("queueMoney(rows)");
    expect(due).toContain("groupMoneySections(rows)");
    // Every list on the page takes its rows from that grouping. A reintroduced
    // `rows.filter(r => r.bucket === ...)` here is the QA-20260826-01 shape
    // returning on the surface that reported it.
    expect(due).not.toMatch(/rows\.filter\(\(r\) => r\.bucket ===/);
  });
});
