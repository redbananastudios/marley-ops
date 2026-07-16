import { describe, expect, it } from "vitest";
import {
  addDaysIso,
  dayLabel,
  isRaised,
  isValidDay,
  monthStart,
  netFromGross,
  outstandingTotal,
  summariseRaised,
  ukTodayDate,
  vatFromGross,
  type FinanceInvoice,
} from "@/lib/finance/invoices";

const inv = (over: Partial<FinanceInvoice>): FinanceInvoice => ({
  invoiceId: "x",
  invoiceNumber: "INV-1",
  reference: "MMR001-DEP",
  customerName: "Jane Smith",
  date: "2026-07-16",
  status: "sent",
  total: 100,
  balance: 100,
  ...over,
});

describe("VAT maths (20% inclusive — matches the Zoho documents)", () => {
  it("splits £100 gross into £83.33 net + £16.67 VAT", () => {
    expect(netFromGross(100)).toBe(83.33);
    expect(vatFromGross(100)).toBe(16.67);
  });

  it("splits £1,020 gross into £850 net + £170 VAT", () => {
    expect(netFromGross(1020)).toBe(850);
    expect(vatFromGross(1020)).toBe(170);
  });

  it("handles zero", () => {
    expect(vatFromGross(0)).toBe(0);
    expect(netFromGross(0)).toBe(0);
  });
});

describe("summariseRaised", () => {
  it("sums issued invoices and computes per-invoice VAT", () => {
    const s = summariseRaised([
      inv({ total: 100 }),
      inv({ total: 1020, status: "paid", balance: 0 }),
    ]);
    expect(s.count).toBe(2);
    expect(s.gross).toBe(1120);
    expect(s.vat).toBe(186.67); // 16.67 + 170
    expect(s.net).toBe(933.33);
  });

  it("excludes void and draft invoices — not raised, no VAT owed", () => {
    const s = summariseRaised([
      inv({ total: 100 }),
      inv({ total: 500, status: "void" }),
      inv({ total: 250, status: "draft" }),
    ]);
    expect(s.count).toBe(1);
    expect(s.gross).toBe(100);
    expect(s.vat).toBe(16.67);
  });

  it("empty set is all zeros", () => {
    expect(summariseRaised([])).toEqual({ count: 0, gross: 0, net: 0, vat: 0 });
  });

  it("per-invoice rounding then sum (not sum-then-round)", () => {
    // 3 × £0.05 gross: per-invoice VAT rounds to £0.01 each → £0.03.
    const s = summariseRaised([inv({ total: 0.05 }), inv({ total: 0.05 }), inv({ total: 0.05 })]);
    expect(s.vat).toBe(0.03);
  });
});

describe("outstandingTotal", () => {
  it("sums balances on issued invoices only, clamping negatives", () => {
    expect(
      outstandingTotal([
        inv({ balance: 100 }),
        inv({ balance: 0, status: "paid" }),
        inv({ balance: 920, status: "overdue" }),
        inv({ balance: 500, status: "void" }), // voided — no longer owed
        inv({ balance: -5 }), // credit oddity — never negative-sums
      ]),
    ).toBe(1020);
  });
});

describe("status buckets", () => {
  it("raised = everything except void and draft", () => {
    expect(isRaised("sent")).toBe(true);
    expect(isRaised("viewed")).toBe(true);
    expect(isRaised("paid")).toBe(true);
    expect(isRaised("partially_paid")).toBe(true);
    expect(isRaised("overdue")).toBe(true);
    expect(isRaised("void")).toBe(false);
    expect(isRaised("draft")).toBe(false);
  });
});

describe("day helpers", () => {
  it("ukTodayDate gives the UK calendar day, not UTC (BST boundary)", () => {
    // 23:30Z on 15 Jul is 00:30 UK on 16 Jul during BST.
    expect(ukTodayDate(new Date("2026-07-15T23:30:00Z"))).toBe("2026-07-16");
    // Winter: UK == UTC.
    expect(ukTodayDate(new Date("2026-01-15T23:30:00Z"))).toBe("2026-01-15");
  });

  it("validates day params and bounds extreme years", () => {
    expect(isValidDay("2026-07-16")).toBe(true);
    expect(isValidDay("2026-7-16")).toBe(false);
    expect(isValidDay("0000-01-01")).toBe(false);
    expect(isValidDay("9999-12-31")).toBe(false);
    expect(isValidDay("not-a-date")).toBe(false);
    expect(isValidDay(undefined)).toBe(false);
  });

  it("addDaysIso crosses month and year ends", () => {
    expect(addDaysIso("2026-07-31", 1)).toBe("2026-08-01");
    expect(addDaysIso("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("monthStart + dayLabel", () => {
    expect(monthStart("2026-07-16")).toBe("2026-07-01");
    expect(dayLabel("2026-07-16")).toContain("16 July 2026");
  });
});
