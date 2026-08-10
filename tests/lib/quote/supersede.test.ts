import { describe, it, expect } from "vitest";
import { planSupersede, refList, type SiblingQuote } from "@/lib/quote/supersede";

const q = (over: Partial<SiblingQuote> & { id: string }): SiblingQuote => ({
  quote_ref: over.id.toUpperCase(),
  status: "sent",
  deposit_paid_at: null,
  zoho_deposit_invoice_id: null,
  zoho_balance_invoice_id: null,
  zoho_commitment_invoice_id: null,
  ...over,
});

describe("planSupersede", () => {
  it("retires the quote a revision replaces", () => {
    // The live case: MMR050 went out with the wrong destination postcode, the
    // customer replied, MMR051 corrected it. Both stayed in Awaiting reply.
    const plan = planSupersede([q({ id: "mmr050" }), q({ id: "mmr051" })], "mmr051");
    expect(plan.supersede.map((x) => x.id)).toEqual(["mmr050"]);
    expect(plan.blocked).toEqual([]);
  });

  it("never retires the quote being sent", () => {
    expect(planSupersede([q({ id: "mmr051" })], "mmr051").supersede).toEqual([]);
  });

  it("leaves an ACCEPTED quote alone", () => {
    // It has a booking, a diary entry and invoices behind it. Retiring it because
    // someone re-quoted would cancel a customer's move as a side effect.
    const plan = planSupersede([q({ id: "old", status: "accepted" })], "new");
    expect(plan.supersede).toEqual([]);
    expect(plan.blocked).toEqual([]);
  });

  it("leaves drafts alone — nobody has seen them", () => {
    expect(planSupersede([q({ id: "old", status: "draft" })], "new").supersede).toEqual([]);
  });

  it("blocks rather than retires when money is attached", () => {
    const plan = planSupersede([q({ id: "paid", deposit_paid_at: "2026-08-10T10:00:00Z" })], "new");
    expect(plan.supersede).toEqual([]);
    expect(plan.blocked.map((x) => x.id)).toEqual(["paid"]);
  });

  it("treats a raised Zoho invoice as money, but not the 'pending' placeholder", () => {
    const raised = planSupersede([q({ id: "inv", zoho_deposit_invoice_id: "12345" })], "new");
    expect(raised.blocked.map((x) => x.id)).toEqual(["inv"]);
    const pending = planSupersede([q({ id: "inv", zoho_deposit_invoice_id: "pending" })], "new");
    expect(pending.supersede.map((x) => x.id)).toEqual(["inv"]);
  });

  it("handles a lead that accumulated several live quotes", () => {
    const plan = planSupersede([q({ id: "a" }), q({ id: "b" }), q({ id: "c" })], "c");
    expect(plan.supersede.map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("does nothing on a lead with no other quotes", () => {
    expect(planSupersede([], "only")).toEqual({ supersede: [], blocked: [] });
  });
});

describe("refList", () => {
  it("reads naturally in the warning the office sees", () => {
    expect(refList([q({ id: "a", quote_ref: "MMR050" })])).toBe("MMR050");
    expect(refList([q({ id: "a", quote_ref: "MMR050" }), q({ id: "b", quote_ref: "MMR051" })])).toBe(
      "MMR050 and MMR051",
    );
    expect(
      refList([
        q({ id: "a", quote_ref: "MMR050" }),
        q({ id: "b", quote_ref: "MMR051" }),
        q({ id: "c", quote_ref: "MMR052" }),
      ]),
    ).toBe("MMR050, MMR051 and MMR052");
  });

  it("copes with a missing reference rather than printing 'null'", () => {
    expect(refList([q({ id: "a", quote_ref: null })])).toBe("an earlier quote");
  });
});
