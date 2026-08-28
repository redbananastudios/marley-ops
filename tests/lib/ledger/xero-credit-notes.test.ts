import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Credit notes, and the refund guard that is the hardest thing in the Xero
 * adapter.
 *
 * Under Zoho, `available <= 0` means "already refunded" — a credit note is only
 * ever consumed by a refund. Under Xero the same arithmetic has TWO causes:
 * `RemainingCredit` is reduced by allocations to other invoices just as much as
 * by refunds. So a straight port reports a refund as done when a human merely
 * applied the credit to another invoice in the Xero UI, and a customer who is
 * owed money never receives it — silently, with the branch that would have
 * shown the gap being the one that just cleared itself.
 *
 * The fixtures below are the shapes the recon read off the live Demo Company,
 * including `CN-0025` — a real allocated-not-refunded credit note that a
 * Zoho-shaped guard reports as £541.25 already repaid.
 */

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  queue: [] as Response[],
  calls: [] as { path: string; init?: RequestInit }[],
  org: { class: "DEMO", isDemoCompany: true, name: "Demo Company (UK)" } as Record<string, unknown>,
  warnings: [] as { event: string; ctx: unknown }[],
}));

vi.mock("@/lib/ledger/xero-client", () => ({
  xeroFetch: vi.fn(async (path: string, init?: RequestInit) => {
    state.calls.push({ path, init });
    const next = state.queue.shift();
    if (!next) throw new Error(`No fixture queued for xeroFetch(${path})`);
    return next;
  }),
  readOrganisation: vi.fn(async () => state.org),
}));

vi.mock("@/lib/log", () => ({
  log: {
    warn: (event: string, ctx: unknown) => state.warnings.push({ event, ctx }),
    info: () => {},
    error: () => {},
    debug: () => {},
  },
}));

import { ALREADY_REFUNDED, LedgerError } from "@/lib/ledger/types";
import {
  createCreditNote,
  findCreditNoteByReference,
  refundCreditNote,
} from "@/lib/ledger/xero-credit-notes";

const BANK_ACCOUNT = "bd9e85e0-0478-433d-ae9f-0b3c4f04bfe4";
const CN_ID = "f0e9c7fc-638c-420e-82c6-9568f08bcb61";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A credit note in the live read shape. Note that `Payments` and `Allocations`
 * BOTH come back on one GET — which is what makes the two causes separately
 * visible and the guard possible at all.
 */
function creditNote(over: Record<string, unknown> = {}) {
  return {
    CreditNoteID: CN_ID,
    CreditNoteNumber: "CN-0051",
    Reference: "MMR001-DEP",
    Type: "ACCRECCREDIT",
    Status: "AUTHORISED",
    Total: 120,
    RemainingCredit: 120,
    Allocations: [] as { Amount: number }[],
    Payments: [] as { PaymentID: string; Amount: number }[],
    ...over,
  };
}

const ENV_KEYS = [
  "XERO_ACCOUNT_INCOME",
  "XERO_ACCOUNT_BANKTRANSFER",
  "XERO_TAX_TYPE_VAT",
  "XERO_TAX_TYPE_NO_VAT",
  "XERO_ALLOW_LIVE_WRITES",
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  process.env.XERO_ACCOUNT_INCOME = "200";
  process.env.XERO_ACCOUNT_BANKTRANSFER = BANK_ACCOUNT;
  process.env.XERO_TAX_TYPE_VAT = "OUTPUT2";
  process.env.XERO_TAX_TYPE_NO_VAT = "NONE";
  delete process.env.XERO_ALLOW_LIVE_WRITES;
  state.queue = [];
  state.calls = [];
  state.warnings = [];
  state.org = { class: "DEMO", isDemoCompany: true, name: "Demo Company (UK)" };
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function sentBody(index = 0): Record<string, unknown> {
  return JSON.parse(String(state.calls[index].init?.body ?? "{}"));
}

/** The refund ask used by every guard test, so only the note's state varies. */
const REFUND = { creditNoteId: CN_ID, amount: 40, mode: "banktransfer" } as const;

/* --------------------------------------------- findCreditNoteByReference */

describe("findCreditNoteByReference", () => {
  it("returns null on a miss", async () => {
    state.queue.push(json({ CreditNotes: [] }));
    await expect(findCreditNoteByReference("MMR001-DEP")).resolves.toBeNull();
  });

  it("maps the single live match", async () => {
    state.queue.push(json({ CreditNotes: [creditNote()] }));
    await expect(findCreditNoteByReference("MMR001-DEP")).resolves.toEqual({
      creditNoteId: CN_ID,
      creditNoteNumber: "CN-0051",
    });
  });

  /**
   * A voided credit note is still returned by a reference query — verified
   * live. Adopting one means refunding against a document that cannot take a
   * refund.
   */
  it("skips voided matches", async () => {
    state.queue.push(json({ CreditNotes: [creditNote({ Status: "VOIDED" })] }));
    await expect(findCreditNoteByReference("MMR001-DEP")).resolves.toBeNull();
  });

  it("refuses when two live notes share the reference", async () => {
    state.queue.push(
      json({
        CreditNotes: [
          creditNote(),
          creditNote({ CreditNoteID: "b", CreditNoteNumber: "CN-0052" }),
        ],
      }),
    );
    await expect(findCreditNoteByReference("MMR001-DEP")).rejects.toThrow(
      /2 live credit notes with reference MMR001-DEP/,
    );
  });

  /** `CreditNotes` has no `searchTerm` parameter at all — `where` is the only option. */
  it("filters on an exact where clause, encoded once", async () => {
    state.queue.push(json({ CreditNotes: [] }));
    await findCreditNoteByReference("MMR001-DEP");
    const path = state.calls[0].path;
    expect(path).toContain("Reference%3D%3D%22MMR001-DEP%22");
    expect(path).toContain("ACCRECCREDIT");
    expect(path).not.toContain("%253D");
    expect(path).not.toContain("+");
  });
});

/* ------------------------------------------------------- createCreditNote */

describe("createCreditNote", () => {
  it("raises an authorised, VAT-inclusive credit note in one call", async () => {
    // createCreditNote adopts by reference first — queue the "nothing there yet" lookup.
    state.queue.push(json({ CreditNotes: [] }));
    state.queue.push(json({ CreditNotes: [creditNote()] }));
    const ref = await createCreditNote({
      customerId: "contact-guid",
      reference: "MMR001-DEP",
      description: "Deposit refund",
      amount: 120,
    });

    // [0] is the adopt-by-reference lookup; [1] is the create itself.
    expect(state.calls[1].path).toBe("/CreditNotes");
    expect(state.calls[1].init?.method).toBe("PUT");
    const note = (sentBody(1).CreditNotes as Record<string, unknown>[])[0];
    // The autodocs' `ACCRECREDITNOTE` appears nowhere in the spec and would be
    // rejected; the enum is exactly [ACCPAYCREDIT, ACCRECCREDIT].
    expect(note.Type).toBe("ACCRECCREDIT");
    expect(note.Status).toBe("AUTHORISED"); // no separate open step, unlike Zoho
    expect(note.LineAmountTypes).toBe("Inclusive");
    expect(note.Contact).toEqual({ ContactID: "contact-guid" });
    expect(ref).toEqual({ creditNoteId: CN_ID, creditNoteNumber: "CN-0051" });
  });

  /**
   * `applyVat` MIRRORS the original invoice rather than re-deriving from the
   * org's current rate. This org carries four historic output-VAT types at
   * three different percentages, so re-deriving can reverse a different amount
   * of VAT than was charged.
   */
  it("mirrors VAT by naming the configured tax type", async () => {
    // createCreditNote adopts by reference first — queue the "nothing there yet" lookup.
    state.queue.push(json({ CreditNotes: [] }));
    state.queue.push(json({ CreditNotes: [creditNote()] }));
    await createCreditNote({
      customerId: "c",
      reference: "MMR001-DEP",
      description: "d",
      amount: 120,
    });
    const line = ((sentBody(1).CreditNotes as Record<string, unknown>[])[0].LineItems as Record<
      string,
      unknown
    >[])[0];
    expect(line.TaxType).toBe("OUTPUT2");
  });

  /**
   * Omitting TaxType would inherit the account's default — the 20% one — and
   * reverse VAT that was never charged.
   */
  it("names the no-VAT type explicitly when applyVat is false", async () => {
    // createCreditNote adopts by reference first — queue the "nothing there yet" lookup.
    state.queue.push(json({ CreditNotes: [] }));
    state.queue.push(json({ CreditNotes: [creditNote()] }));
    await createCreditNote({
      customerId: "c",
      reference: "MMR001-DEP",
      description: "d",
      amount: 120,
      applyVat: false,
    });
    const line = ((sentBody(1).CreditNotes as Record<string, unknown>[])[0].LineItems as Record<
      string,
      unknown
    >[])[0];
    expect(line.TaxType).toBe("NONE");
  });

  it("refuses to raise a credit note against live books", async () => {
    state.org = { class: "COMPANY", isDemoCompany: false, name: "MarleyMoves Ltd" };
    await expect(
      createCreditNote({ customerId: "c", reference: "MMR001-DEP", description: "d", amount: 120 }),
    ).rejects.toThrow(/READ-ONLY until the cutover/);
    expect(state.calls).toHaveLength(0);
  });
});

/* ================================================== the refund guard, in full */

describe("refundCreditNote — the ALREADY_REFUNDED sentinel", () => {
  /** Branch 2: refunds cover the ask and nothing is left. A retry is safe. */
  it("returns the sentinel when the note was genuinely refunded", async () => {
    state.queue.push(
      json({
        CreditNotes: [
          creditNote({
            RemainingCredit: 0,
            Payments: [{ PaymentID: "p1", Amount: 120 }],
          }),
        ],
      }),
    );
    await expect(refundCreditNote({ ...REFUND, amount: 120 })).resolves.toBe(ALREADY_REFUNDED);
    expect(state.calls).toHaveLength(1); // read only — no second payment
  });

  /**
   * Branch 3, and the live-money one. `CN-0025` from the demo org: PAID,
   * RemainingCredit 0.00, £541.25 ALLOCATED to INV-0016, zero payments. Nothing
   * left the bank. Reporting this as already refunded withholds real money.
   */
  it("REFUSES rather than returning the sentinel when the credit was allocated, not refunded", async () => {
    state.queue.push(
      json({
        CreditNotes: [
          creditNote({
            CreditNoteNumber: "CN-0025",
            Status: "PAID", // "fully consumed", NOT "refunded"
            Total: 541.25,
            RemainingCredit: 0,
            Allocations: [{ Amount: 541.25 }],
            Payments: [],
          }),
        ],
      }),
    );
    const call = refundCreditNote({ ...REFUND, amount: 541.25 });
    await expect(call).rejects.toThrow(LedgerError);
    expect(state.calls).toHaveLength(1);
  });

  it("says in the refusal that this is not an already-refunded case", async () => {
    state.queue.push(
      json({
        CreditNotes: [
          creditNote({ Total: 541.25, RemainingCredit: 0, Allocations: [{ Amount: 541.25 }] }),
        ],
      }),
    );
    await expect(refundCreditNote({ ...REFUND, amount: 541.25 })).rejects.toThrow(
      /not an already-refunded case/,
    );
  });

  /** Partially both, and the refunds do cover what we are being asked for. */
  it("returns the sentinel when part was allocated and the refunds cover the ask", async () => {
    state.queue.push(
      json({
        CreditNotes: [
          creditNote({
            RemainingCredit: 0,
            Allocations: [{ Amount: 80 }],
            Payments: [{ PaymentID: "p1", Amount: 40 }],
          }),
        ],
      }),
    );
    await expect(refundCreditNote(REFUND)).resolves.toBe(ALREADY_REFUNDED);
  });

  /**
   * Partially both, but our £40 was NOT what went back — only £20 was refunded
   * and a human took the other £100 as an allocation. That is a person's
   * decision to explain, not a sentinel.
   */
  it("refuses when part was refunded but not enough to be the refund we were asked for", async () => {
    state.queue.push(
      json({
        CreditNotes: [
          creditNote({
            RemainingCredit: 0,
            Allocations: [{ Amount: 100 }],
            Payments: [{ PaymentID: "p1", Amount: 20 }],
          }),
        ],
      }),
    );
    await expect(refundCreditNote(REFUND)).rejects.toThrow(/a human must decide/);
  });
});

describe("refundCreditNote — the checksum", () => {
  /**
   * Xero's own `RemainingCredit` and the two arrays are two accounts of the
   * same fact. When they disagree we are looking at a partial picture, and the
   * dangerous reading is the confident one.
   */
  it("refuses to decide when RemainingCredit disagrees with the arrays", async () => {
    state.queue.push(
      json({ CreditNotes: [creditNote({ RemainingCredit: 0, Allocations: [], Payments: [] })] }),
    );
    await expect(refundCreditNote(REFUND)).rejects.toThrow(/Refusing to decide/);
    expect(state.calls).toHaveLength(1);
  });

  /**
   * The failure this exists for: a future Xero response that trims `Payments`.
   * Without the checksum the sums read low, `refunded` reads 0, and the
   * allocation branch fires on a note that WAS refunded.
   */
  it("catches a trimmed Payments array rather than reading it as zero refunds", async () => {
    const note = creditNote({ RemainingCredit: 80, Allocations: [] }) as Record<string, unknown>;
    delete note.Payments;
    state.queue.push(json({ CreditNotes: [note] }));
    await expect(refundCreditNote(REFUND)).rejects.toThrow(/does not reconcile|Refusing to decide/);
  });

  /** Penny rounding must not trip the checksum. */
  it("tolerates sub-penny drift", async () => {
    state.queue.push(
      json({
        CreditNotes: [
          creditNote({
            Total: 100,
            RemainingCredit: 59.999,
            Allocations: [{ Amount: 40.001 }],
          }),
        ],
      }),
      json({ Payments: [{ PaymentID: "pay-1" }] }),
    );
    await expect(refundCreditNote(REFUND)).resolves.toBe("pay-1");
  });
});

describe("refundCreditNote — paying the money back", () => {
  it("posts against the CreditNote identifier and the configured account", async () => {
    state.queue.push(
      json({ CreditNotes: [creditNote()] }),
      json({ Payments: [{ PaymentID: "pay-1" }] }),
    );
    const id = await refundCreditNote({ ...REFUND, reference: "MMR001-DEP refund" });
    expect(id).toBe("pay-1");
    expect(state.calls[1].path).toBe("/Payments");
    expect(state.calls[1].init?.method).toBe("PUT");

    const payment = (sentBody(1).Payments as Record<string, unknown>[])[0];
    // Exactly ONE identifier object, and it must be the credit note: the same
    // endpoint records invoice payments, and the identifier is the only thing
    // that says which direction the money is going.
    expect(payment.CreditNote).toEqual({ CreditNoteID: CN_ID });
    expect("Invoice" in payment).toBe(false);
    expect(payment.Account).toEqual({ AccountID: BANK_ACCOUNT });
    expect(payment.Amount).toBe(40);
  });

  /** Same wording as the Zoho path, which an operator has read before. */
  it("refuses to over-refund, in the wording the ops alert already uses", async () => {
    state.queue.push(
      json({
        CreditNotes: [
          creditNote({ RemainingCredit: 30, Payments: [{ PaymentID: "p1", Amount: 90 }] }),
        ],
      }),
    );
    await expect(refundCreditNote(REFUND)).rejects.toThrow(
      /has only £30.00 left to refund \(asked £40.00\)/,
    );
  });

  it("refuses to refund a voided credit note", async () => {
    state.queue.push(json({ CreditNotes: [creditNote({ Status: "VOIDED" })] }));
    await expect(refundCreditNote(REFUND)).rejects.toThrow(/cannot take a refund/);
  });

  it("refuses a zero or negative amount before reading anything", async () => {
    await expect(refundCreditNote({ ...REFUND, amount: 0 })).rejects.toThrow(LedgerError);
    expect(state.calls).toHaveLength(0);
  });

  it("refuses to move money in live books", async () => {
    state.org = { class: "COMPANY", isDemoCompany: false, name: "MarleyMoves Ltd" };
    await expect(refundCreditNote(REFUND)).rejects.toThrow(/READ-ONLY until the cutover/);
    expect(state.calls).toHaveLength(0);
  });

  /** A refused payment arriving under HTTP 200 must not read as a refund made. */
  it("throws when the 200 carries a rejected payment", async () => {
    state.queue.push(
      json({ CreditNotes: [creditNote()] }),
      json({
        Payments: [
          {
            HasValidationErrors: true,
            ValidationErrors: [
              { Message: "Payment amount exceeds the amount outstanding on this document" },
            ],
          },
        ],
      }),
    );
    await expect(refundCreditNote(REFUND)).rejects.toThrow(/exceeds the amount outstanding/);
  });
});
