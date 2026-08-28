import { describe, expect, it } from "vitest";
import {
  payInFullAvailable,
  type PayInFullLead,
  type PayInFullQuote,
} from "@/lib/payments/pay-in-full";

const quote = (over: Partial<PayInFullQuote> = {}): PayInFullQuote => ({
  status: "accepted",
  booking_cancelled_at: null,
  deposit_paid_at: "2026-08-01T10:00:00Z",
  zoho_commitment_invoice_id: "inv_com_1",
  commitment_paid_at: null,
  zoho_balance_invoice_id: null,
  source: "marley_ops",
  standard_comms_at: null,
  ...over,
});

const lead = (over: Partial<PayInFullLead> = {}): PayInFullLead => ({
  date_confirmed_at: "2026-08-02T10:00:00Z",
  balance_paid_at: null,
  ...over,
});

describe("payInFullAvailable", () => {
  it("offers the choice at the commitment step", () => {
    expect(payInFullAvailable(quote(), lead())).toBe(true);
  });

  describe("the ladder has to have reached this step", () => {
    it("not before the date is confirmed", () => {
      expect(payInFullAvailable(quote(), lead({ date_confirmed_at: null }))).toBe(false);
    });

    it("not before the deposit is paid", () => {
      expect(payInFullAvailable(quote({ deposit_paid_at: null }), lead())).toBe(false);
    });

    it("not without a lead to read the ladder from", () => {
      expect(payInFullAvailable(quote(), null)).toBe(false);
      expect(payInFullAvailable(quote(), undefined)).toBe(false);
    });
  });

  describe("there has to be a rest to settle", () => {
    it("no commitment invoice → nothing to attach the choice to", () => {
      // This is how gate 9a (small job) and gate 9b (late booking) fall out
      // without being special-cased: both leave commitmentAmount at zero, so no
      // -COM is ever raised and this returns false on its own.
      expect(payInFullAvailable(quote({ zoho_commitment_invoice_id: null }), lead())).toBe(false);
    });

    it("a commitment mid-raise is not a commitment yet", () => {
      expect(payInFullAvailable(quote({ zoho_commitment_invoice_id: "pending" }), lead())).toBe(
        false,
      );
    });

    it("the commitment is already paid → the balance rail owns the rest", () => {
      expect(payInFullAvailable(quote({ commitment_paid_at: "2026-08-03T10:00:00Z" }), lead())).toBe(
        false,
      );
    });

    it("the balance is already raised → the choice has been taken, or T-7 got there first", () => {
      expect(payInFullAvailable(quote({ zoho_balance_invoice_id: "inv_bal_1" }), lead())).toBe(false);
      expect(payInFullAvailable(quote({ zoho_balance_invoice_id: "pending" }), lead())).toBe(false);
    });

    it("the balance is already settled", () => {
      expect(payInFullAvailable(quote(), lead({ balance_paid_at: "2026-08-04T10:00:00Z" }))).toBe(
        false,
      );
    });
  });

  describe("refusals that protect the customer", () => {
    it("skips a quote that is not accepted", () => {
      for (const status of ["sent", "draft", "declined", "lost"]) {
        expect(payInFullAvailable(quote({ status }), lead())).toBe(false);
      }
    });

    it("skips a cancelled booking", () => {
      expect(
        payInFullAvailable(quote({ booking_cancelled_at: "2026-08-03T10:00:00Z" }), lead()),
      ).toBe(false);
    });

    it("skips a legacy iMVE booking the office has not yet phoned", () => {
      // These never agreed a commitment ladder at all, so an option to settle
      // one early is meaningless to them.
      expect(payInFullAvailable(quote({ source: "imve" }), lead())).toBe(false);
    });

    it("treats an iMVE booking as ordinary once standard comms are on", () => {
      expect(
        payInFullAvailable(
          quote({ source: "imve", standard_comms_at: "2026-08-01T09:00:00Z" }),
          lead(),
        ),
      ).toBe(true);
    });
  });
});
