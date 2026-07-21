import { describe, expect, it } from "vitest";
import {
  buildHeldFromSources,
  type SnapshotCardRow,
  type SnapshotLead,
  type SnapshotQuote,
} from "@/lib/refunds";
import { splitHeldMoney } from "@/lib/payments-policy";

/**
 * The pure held-money snapshot core (Payments Policy v2). This closes the old
 * mark-lost gap: "money taken" was inferred from paid flags only — the
 * snapshot must read card_payments rows (net of refunds) for the card rail,
 * and must never double-count a card-paid deposit against its recorded stamp.
 */

const card = (over: Partial<SnapshotCardRow> = {}): SnapshotCardRow => ({
  id: "cp-1",
  status: "paid",
  amount_pence: 10000,
  refunded_pence: 0,
  is_test: false,
  kind: "deposit",
  settled_at: "2026-07-01T10:00:00Z",
  created_at: "2026-07-01T09:59:00Z",
  ...over,
});

const quote = (over: Partial<SnapshotQuote> = {}): SnapshotQuote => ({
  id: "q-1",
  quote_ref: "MMR001",
  client_id: "c-1",
  customer_name: "Freddy Arbuthnot",
  agreed_price: 2400,
  grand_total: 2400,
  deposit_amount: 100,
  deposit_paid_at: null,
  deposit_paid_method: null,
  commitment_invoice_amount: null,
  commitment_paid_at: null,
  commitment_paid_method: null,
  balance_invoice_amount: null,
  zoho_deposit_invoice_id: null,
  zoho_commitment_invoice_id: null,
  zoho_balance_invoice_id: null,
  ...over,
});

const lead = (over: Partial<SnapshotLead> = {}): SnapshotLead => ({
  id: "l-1",
  name: "Freddy Arbuthnot",
  balance_paid_at: null,
  balance_amount: null,
  ...over,
});

describe("buildHeldFromSources — card rail", () => {
  it("holds a paid card payment at its full amount", () => {
    const held = buildHeldFromSources({ cardRows: [card()], quote: null, lead: null });
    expect(held).toEqual([
      expect.objectContaining({
        rail: "card",
        amount: 100,
        card_payment_id: "cp-1",
        label: "card deposit",
      }),
    ]);
  });

  it("nets partial refunds off the held amount", () => {
    const held = buildHeldFromSources({
      cardRows: [card({ status: "partially_refunded", refunded_pence: 2500 })],
      quote: null,
      lead: null,
    });
    expect(held[0].amount).toBe(75);
  });

  it("drops fully-refunded, non-money and test rows", () => {
    const held = buildHeldFromSources({
      cardRows: [
        card({ id: "a", status: "refunded", refunded_pence: 10000 }),
        card({ id: "b", status: "partially_refunded", refunded_pence: 10000 }), // net 0
        card({ id: "c", status: "pending" }),
        card({ id: "d", status: "failed" }),
        card({ id: "e", status: "abandoned" }),
        card({ id: "f", status: "needs_review" }), // human reconciles first
        card({ id: "g", is_test: true }),
      ],
      quote: null,
      lead: null,
    });
    expect(held).toEqual([]);
  });
});

describe("buildHeldFromSources — recorded rails + card dedupe", () => {
  it("a card-paid deposit is NOT double-counted from its recorded stamp", () => {
    const held = buildHeldFromSources({
      cardRows: [card()],
      quote: quote({ deposit_paid_at: "2026-07-01T10:00:00Z", deposit_paid_method: "card" }),
      lead: lead(),
    });
    expect(held).toHaveLength(1);
    expect(held[0].rail).toBe("card");
  });

  it("a bank-transfer deposit is held on the bank rail with its Zoho invoice id", () => {
    const held = buildHeldFromSources({
      cardRows: [],
      quote: quote({
        deposit_paid_at: "2026-07-02T09:00:00Z",
        deposit_paid_method: "bank_transfer",
        zoho_deposit_invoice_id: "zoho-123",
      }),
      lead: lead(),
    });
    expect(held).toEqual([
      expect.objectContaining({
        rail: "bank_transfer",
        amount: 100,
        label: "deposit",
        zoho_invoice_id: "zoho-123",
      }),
    ]);
  });

  it("an in-flight 'pending' Zoho claim never leaks into the snapshot as a real id", () => {
    const held = buildHeldFromSources({
      cardRows: [],
      quote: quote({
        deposit_paid_at: "2026-07-02T09:00:00Z",
        deposit_paid_method: "cash",
        zoho_deposit_invoice_id: "pending",
      }),
      lead: lead(),
    });
    expect(held[0].zoho_invoice_id).toBeNull();
    expect(held[0].rail).toBe("cash");
  });

  it("a paid commitment is held with its frozen invoice amount and method rail", () => {
    const held = buildHeldFromSources({
      cardRows: [],
      quote: quote({
        commitment_invoice_amount: 500,
        commitment_paid_at: "2026-07-05T09:00:00Z",
        commitment_paid_method: "cash",
        zoho_commitment_invoice_id: "zoho-com-1",
      }),
      lead: lead(),
    });
    expect(held).toEqual([
      expect.objectContaining({
        rail: "cash",
        amount: 500,
        label: "commitment",
        zoho_invoice_id: "zoho-com-1",
      }),
    ]);
  });

  it("a paid balance defaults to the bank rail (no method is persisted; balance is never card)", () => {
    const held = buildHeldFromSources({
      cardRows: [],
      quote: quote({ balance_invoice_amount: 2300 }),
      lead: lead({ balance_paid_at: "2026-07-10T09:00:00Z", balance_amount: null }),
    });
    expect(held).toEqual([
      expect.objectContaining({ rail: "bank_transfer", amount: 2300, label: "balance" }),
    ]);
  });

  it("lead.balance_amount wins over the quote's invoice amount when both exist", () => {
    const held = buildHeldFromSources({
      cardRows: [],
      quote: quote({ balance_invoice_amount: 2300 }),
      lead: lead({ balance_paid_at: "2026-07-10T09:00:00Z", balance_amount: 2250 }),
    });
    expect(held[0].amount).toBe(2250);
  });

  it("unpaid stamps and zero amounts produce nothing", () => {
    const held = buildHeldFromSources({
      cardRows: [],
      quote: quote({ deposit_paid_at: "2026-07-02T09:00:00Z", deposit_amount: null }),
      lead: lead(),
    });
    expect(held).toEqual([]);
  });
});

describe("buildHeldFromSources — chronology", () => {
  it("sorts first-money-in first, whatever order the sources arrive in", () => {
    const held = buildHeldFromSources({
      cardRows: [card({ settled_at: "2026-07-08T10:00:00Z" })],
      quote: quote({
        deposit_paid_at: "2026-07-01T09:00:00Z",
        deposit_paid_method: "bank_transfer",
        commitment_invoice_amount: 500,
        commitment_paid_at: "2026-07-05T09:00:00Z",
        commitment_paid_method: "bank_transfer",
      }),
      lead: lead(),
    });
    expect(held.map((h) => h.label)).toEqual(["deposit", "commitment", "card deposit"]);
  });
});

describe("snapshot → split integration (the queue-row numbers)", () => {
  it("PRD scenario: £100 bank deposit then £350 bank commitment on a £1,400 job", () => {
    const held = buildHeldFromSources({
      cardRows: [],
      quote: quote({
        agreed_price: 1400,
        deposit_paid_at: "2026-07-01T09:00:00Z",
        deposit_paid_method: "bank_transfer",
        commitment_invoice_amount: 350,
        commitment_paid_at: "2026-07-05T09:00:00Z",
        commitment_paid_method: "bank_transfer",
      }),
      lead: lead(),
    });
    const split = splitHeldMoney(held, 1400);
    // Cap = £350; deposit (first in) + £250 of the commitment are conditional,
    // the £100 above the cap refunds regardless of fill.
    expect(split.conditional).toBe(350);
    expect(split.unconditional).toBe(100);
    expect(split.byRail.bank_transfer.total).toBe(450);
  });
});
