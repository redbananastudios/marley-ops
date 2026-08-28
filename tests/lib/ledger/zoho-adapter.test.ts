import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Zoho adapter's contract is ZERO behaviour change. These tests pin the two
 * places where it is not a bare pass-through — the neutral status filter and
 * error wrapping — and prove the pass-throughs really are pass-throughs.
 */

// Hoisted with the mock factory: vi.mock is lifted above every top-level
// declaration, so a class declared out here would not exist yet when the
// factory runs.
const { FakeZohoError } = vi.hoisted(() => ({
  FakeZohoError: class FakeZohoError extends Error {
    constructor(
      message: string,
      public zohoCode?: number,
      public httpStatus?: number,
    ) {
      super(message);
      this.name = "ZohoError";
    }
  },
}));

const z = vi.hoisted(() => ({
  listInvoices: vi.fn(),
  getInvoiceStatus: vi.fn(),
  voidInvoice: vi.fn(),
  createInvoice: vi.fn(),
  zohoInvoiceAppUrl: vi.fn(),
  findOrCreateContact: vi.fn(),
  findInvoiceByReference: vi.fn(),
  invoiceCarriesVat: vi.fn(),
  getInvoicePdfBase64: vi.fn(),
  recordInvoicePayment: vi.fn(),
  findCreditNoteByReference: vi.fn(),
  createCreditNote: vi.fn(),
  refundCreditNote: vi.fn(),
}));

vi.mock("@/lib/zoho", () => ({ ...z, ZohoError: FakeZohoError }));

import { LedgerError } from "@/lib/ledger/types";
import { zohoAdapter } from "@/lib/ledger/zoho-adapter";

beforeEach(() => vi.clearAllMocks());

describe("status filter translation", () => {
  it('turns the neutral status:"unpaid" into Zoho\'s own Status.Unpaid bucket', async () => {
    z.listInvoices.mockResolvedValue({ invoices: [], truncated: false });
    await zohoAdapter.listInvoices({ dateStart: "2026-08-01", status: "unpaid" });
    expect(z.listInvoices).toHaveBeenCalledWith({
      dateStart: "2026-08-01",
      dateEnd: undefined,
      filterBy: "Status.Unpaid",
    });
  });

  /**
   * Passing `filterBy: undefined` would be harmless today, but the key must be
   * ABSENT rather than undefined so the omission is unambiguous at the seam.
   */
  it("omits filterBy entirely when no status is asked for", async () => {
    z.listInvoices.mockResolvedValue({ invoices: [], truncated: false });
    await zohoAdapter.listInvoices({ dateStart: "2026-08-01", dateEnd: "2026-08-31" });
    const arg = z.listInvoices.mock.calls[0][0];
    expect("filterBy" in arg).toBe(false);
  });

  it("carries the truncation flag through untouched — a capped list must say so", async () => {
    z.listInvoices.mockResolvedValue({ invoices: [], truncated: true });
    await expect(zohoAdapter.listInvoices({})).resolves.toMatchObject({ truncated: true });
  });
});

describe("error wrapping", () => {
  /**
   * `Refusing to void <n>: payment already applied` is read by a human in an ops
   * alert and is pinned by lib/zoho.ts's own tests. It must survive the seam
   * byte-for-byte.
   */
  it("re-clothes a ZohoError as a LedgerError with the message verbatim", async () => {
    z.voidInvoice.mockRejectedValue(
      new FakeZohoError("Refusing to void INV-000042: payment already applied", 4001, 400),
    );
    await expect(zohoAdapter.voidInvoice("inv_1")).rejects.toThrow(LedgerError);
    await expect(zohoAdapter.voidInvoice("inv_1")).rejects.toThrow(
      "Refusing to void INV-000042: payment already applied",
    );
  });

  it("carries the provider's own code and http status onto the LedgerError", async () => {
    z.getInvoiceStatus.mockRejectedValue(new FakeZohoError("boom", 1234, 429));
    const err = await zohoAdapter.getInvoiceStatus("inv_1").catch((e) => e);
    expect(err).toBeInstanceOf(LedgerError);
    expect(err.providerCode).toBe(1234);
    expect(err.httpStatus).toBe(429);
  });

  /**
   * A network abort or a bug in our own code is not a ledger fault. Relabelling
   * it would make a real crash read as "the books are unreachable".
   */
  it("rethrows a non-provider error untouched", async () => {
    const boom = new TypeError("fetch failed");
    z.createInvoice.mockRejectedValue(boom);
    await expect(
      zohoAdapter.createInvoice({ customerId: "c", reference: "MMR001-DEP", description: "d", amount: 100 }),
    ).rejects.toBe(boom);
  });

  it("still resolves normally when nothing throws", async () => {
    z.getInvoiceStatus.mockResolvedValue({
      invoiceId: "i",
      invoiceNumber: "INV-1",
      invoiceUrl: null,
      status: "paid",
      total: 100,
      balance: 0,
    });
    await expect(zohoAdapter.getInvoiceStatus("i")).resolves.toMatchObject({ status: "paid" });
  });
});

describe("pass-throughs", () => {
  it("delegates createInvoice with the input untouched, disableOnlinePayments included", async () => {
    z.createInvoice.mockResolvedValue({ invoiceId: "i", invoiceNumber: "n", invoiceUrl: null });
    const input = {
      customerId: "c1",
      reference: "MMR001-BAL",
      description: "Balance",
      amount: 1234.56,
      disableOnlinePayments: true,
      itemName: "Storage",
    };
    await zohoAdapter.createInvoice(input);
    expect(z.createInvoice).toHaveBeenCalledWith(input);
  });

  it("keeps invoiceAppUrl synchronous — it is called inside JSX in a non-async component", () => {
    z.zohoInvoiceAppUrl.mockReturnValue("https://invoice.zoho.eu/app/1#/invoices/i");
    const url = zohoAdapter.invoiceAppUrl("i");
    expect(typeof url).toBe("string");
    expect(url).toContain("/invoices/i");
  });

  it("reports its own provider", () => {
    expect(zohoAdapter.provider).toBe("zoho");
  });

  /**
   * Gate 18a added a required `party` to the seam so Xero can key contacts on a
   * stable id instead of the customer's name. Zoho has no `ContactNumber`
   * equivalent, and zero behaviour change on the live books is this adapter's
   * whole contract — so the field must be DROPPED, not forwarded.
   *
   * Forwarding it would in fact behave identically today, because `lib/zoho.ts`
   * builds its POST body field by field and ignores unknown keys. That is a
   * coincidence, not a guarantee, and this is the test that turns "Zoho didn't
   * change" from an assumption into an assertion. The method had no assertions
   * at all before this.
   */
  it("drops the contact party — Zoho must not see it", async () => {
    z.findOrCreateContact.mockResolvedValue("zc1");
    await zohoAdapter.findOrCreateContact({
      name: "John Smith",
      email: "j@example.com",
      phone: "+447700900000",
      party: { kind: "client", id: "c1" },
    });
    const arg = z.findOrCreateContact.mock.calls[0][0];
    expect(arg).toEqual({ name: "John Smith", email: "j@example.com", phone: "+447700900000" });
    expect("party" in arg).toBe(false);
  });

  it("drops it unconditionally — both party kinds reach Zoho identically", async () => {
    z.findOrCreateContact.mockResolvedValue("zc1");
    await zohoAdapter.findOrCreateContact({ name: "A", party: { kind: "client", id: "c1" } });
    await zohoAdapter.findOrCreateContact({ name: "A", party: { kind: "quote", id: "q1" } });
    const [first, second] = z.findOrCreateContact.mock.calls.map((c) => c[0]);
    expect(first).toEqual(second);
  });
});
