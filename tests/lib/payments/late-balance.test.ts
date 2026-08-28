import { describe, expect, it } from "vitest";
import { lateBalanceDueAtAcceptance, type LateBalanceQuote } from "@/lib/payments/late-balance";

/** 13 Aug 2026, 09:00Z — 10:00 BST, comfortably inside the UK day. */
const TODAY = new Date("2026-08-13T09:00:00Z");

const quote = (over: Partial<LateBalanceQuote> = {}): LateBalanceQuote => ({
  status: "accepted",
  moving_date: "2026-08-18", // 5 days out — inside the window
  zoho_balance_invoice_id: null,
  booking_cancelled_at: null,
  source: "marley_ops",
  standard_comms_at: null,
  ...over,
});

describe("lateBalanceDueAtAcceptance", () => {
  it("raises for a signed, in-window acceptance", () => {
    expect(lateBalanceDueAtAcceptance(quote(), true, TODAY)).toBe(true);
  });

  it("does NOT raise without the customer's contract signature", () => {
    // Office 'Mark won' writes no signature. That booking keeps today's
    // behaviour: its balance waits for the cron, which waits for the date to
    // be confirmed. This is the MMR019 guard, held rather than bypassed.
    expect(lateBalanceDueAtAcceptance(quote(), false, TODAY)).toBe(false);
  });

  describe("the window boundary", () => {
    it("includes a move exactly 7 days out (the commitment falls due today)", () => {
      expect(lateBalanceDueAtAcceptance(quote({ moving_date: "2026-08-20" }), true, TODAY)).toBe(true);
    });

    it("excludes a move 8 days out — the ordinary ladder has time to run", () => {
      expect(lateBalanceDueAtAcceptance(quote({ moving_date: "2026-08-21" }), true, TODAY)).toBe(false);
    });

    it("includes today and a move already in the past", () => {
      expect(lateBalanceDueAtAcceptance(quote({ moving_date: "2026-08-13" }), true, TODAY)).toBe(true);
      expect(lateBalanceDueAtAcceptance(quote({ moving_date: "2026-08-01" }), true, TODAY)).toBe(true);
    });

    it("excludes a booking with no date at all — nothing to be late for", () => {
      expect(lateBalanceDueAtAcceptance(quote({ moving_date: null }), true, TODAY)).toBe(false);
    });
  });

  describe("refusals that protect an existing document", () => {
    it("never raises a second balance invoice", () => {
      expect(lateBalanceDueAtAcceptance(quote({ zoho_balance_invoice_id: "inv_1" }), true, TODAY)).toBe(false);
    });

    it("stands off a claim another caller is holding", () => {
      // The CAS claim writes the literal 'pending' before the ledger call.
      expect(lateBalanceDueAtAcceptance(quote({ zoho_balance_invoice_id: "pending" }), true, TODAY)).toBe(false);
    });
  });

  describe("refusals that protect the customer", () => {
    it("skips a quote that is not accepted", () => {
      for (const status of ["sent", "draft", "declined", "lost"]) {
        expect(lateBalanceDueAtAcceptance(quote({ status }), true, TODAY)).toBe(false);
      }
    });

    it("skips a cancelled booking", () => {
      expect(
        lateBalanceDueAtAcceptance(quote({ booking_cancelled_at: "2026-08-12T10:00:00Z" }), true, TODAY),
      ).toBe(false);
    });

    it("skips a legacy iMVE booking the office has not yet phoned", () => {
      expect(lateBalanceDueAtAcceptance(quote({ source: "imve" }), true, TODAY)).toBe(false);
    });

    it("treats an iMVE booking as ordinary once standard comms are on", () => {
      expect(
        lateBalanceDueAtAcceptance(
          quote({ source: "imve", standard_comms_at: "2026-08-11T10:00:00Z" }),
          true,
          TODAY,
        ),
      ).toBe(true);
    });
  });
});
