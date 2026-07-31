import { describe, expect, it } from "vitest";
import {
  applyBankFeedFloor,
  isInboundPayment,
  parseAmount,
  parseSheetRows,
  resolveBankFeedFloor,
  ukDateToIso,
  type BankTxRow,
} from "@/lib/bank-feed/parse";
import { matchTransaction, refsInText, type OpenItem } from "@/lib/bank-feed/match";

/* ------------------------------------------------------------ parse */

const HEADERS = [
  "Transaction ID", "Date", "Time", "Type", "Name", "Emoji", "Category", "Amount",
  "Currency", "Local amount", "Local currency", "Notes and #tags", "Address",
  "Receipt", "Description", "Category split", "Pot name",
];

const row = (over: Partial<Record<string, string | number>>): (string | number)[] =>
  HEADERS.map((h) =>
    ({
      "Transaction ID": "tx_0000Abc",
      Date: "16/07/2026",
      Time: "10:15:00",
      Type: "Faster payment",
      Name: "JANE SMITH",
      Amount: 100,
      Currency: "GBP",
      "Notes and #tags": "MMR001-DEP",
      Description: "JANE SMITH MMR001-DEP",
      ...over,
    })[h] ?? "",
  );

describe("parseSheetRows (Monzo export)", () => {
  it("maps by header name, converts UK dates, handles numeric amounts", () => {
    const { rows, skipped } = parseSheetRows([HEADERS, row({})]);
    expect(skipped).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      transactionId: "tx_0000Abc",
      txDate: "2026-07-16",
      txType: "Faster payment",
      counterparty: "JANE SMITH",
      amount: 100,
      reference: "MMR001-DEP",
    });
  });

  it("COUNTS rows it can't safely ingest instead of silently dropping them", () => {
    const { rows, skipped } = parseSheetRows([
      HEADERS,
      row({ "Transaction ID": "" }), // blank spacer — not data loss, not counted
      row({ Date: "2026-07-16" }), // ISO in a DD/MM/YYYY column
      row({ Amount: "one hundred" }),
      row({ "Transaction ID": "tx_ok" }),
    ]);
    expect(rows.map((r) => r.transactionId)).toEqual(["tx_ok"]);
    expect(skipped).toBe(2);
  });

  it("comma/currency-formatted amounts still parse (FORMATTED_VALUE leak-through)", () => {
    const { rows, skipped } = parseSheetRows([HEADERS, row({ Amount: "£1,020.00" })]);
    expect(skipped).toBe(0);
    expect(rows[0].amount).toBe(1020);
  });

  it("THROWS on schema drift of any load-bearing header (incl. Type and Notes)", () => {
    const renamed = HEADERS.map((h) => (h === "Type" ? "Kind" : h));
    expect(() => parseSheetRows([renamed, row({})])).toThrow(/Type/);
    const noNotes = HEADERS.map((h) => (h === "Notes and #tags" ? "Memo" : h));
    expect(() => parseSheetRows([noNotes, row({})])).toThrow(/Notes/);
  });

  it("impossible dates are rejected (Date.parse rolls 31/02 over — round-trip doesn't)", () => {
    expect(ukDateToIso("31/02/2026")).toBeNull();
    expect(ukDateToIso("31/06/2026")).toBeNull();
    expect(ukDateToIso("29/02/2028")).toBe("2028-02-29"); // leap year is real
    expect(ukDateToIso("01/06/2026")).toBe("2026-06-01");
    expect(ukDateToIso("2026-06-01")).toBeNull();
  });

  it("parseAmount handles numbers, strings, formatting and garbage", () => {
    expect(parseAmount(1020.5)).toBe(1020.5);
    expect(parseAmount("1,020.00")).toBe(1020);
    expect(parseAmount("£100")).toBe(100);
    expect(parseAmount("-60.90")).toBe(-60.9);
    expect(parseAmount("")).toBeNull();
    expect(parseAmount("n/a")).toBeNull();
  });
});

describe("isInboundPayment", () => {
  it("positive faster payments, BACS credits and Monzo-to-Monzo transfers are inbound", () => {
    expect(isInboundPayment({ amount: 100, txType: "Faster payment" })).toBe(true);
    expect(isInboundPayment({ amount: 920, txType: "Bacs (Direct Credit)" })).toBe(true);
    // Customers who bank with Monzo arrive as this type (live £1 test, 16 Jul).
    expect(isInboundPayment({ amount: 1, txType: "Monzo-to-Monzo" })).toBe(true);
  });

  it("outbound, pot transfers and card activity are not", () => {
    expect(isInboundPayment({ amount: -60.9, txType: "Faster payment" })).toBe(false);
    expect(isInboundPayment({ amount: 60.9, txType: "Pot transfer" })).toBe(false);
    expect(isInboundPayment({ amount: 500, txType: "Card payment" })).toBe(false);
  });
});

/* ------------------------------------------------------------ go-live floor */

const tx = (txDate: string): BankTxRow => ({
  transactionId: `tx_${txDate}`,
  txDate,
  txTime: null,
  txType: "Faster payment",
  counterparty: null,
  amount: 100,
  currency: "GBP",
  reference: null,
  description: null,
  raw: {},
});

describe("bank-feed go-live floor (BANK_FEED_SINCE — mirrors LEAD_SYNC_SINCE)", () => {
  it("resolveBankFeedFloor: unset/empty/garbled → null (no floor, behaviour unchanged)", () => {
    expect(resolveBankFeedFloor(undefined)).toBeNull();
    expect(resolveBankFeedFloor(null)).toBeNull();
    expect(resolveBankFeedFloor("")).toBeNull();
    expect(resolveBankFeedFloor("not-a-date")).toBeNull();
    expect(resolveBankFeedFloor("2026-13-45")).toBeNull(); // impossible date, not silently everything
  });

  it("resolveBankFeedFloor: an ISO date or datetime resolves to the yyyy-mm-dd floor", () => {
    expect(resolveBankFeedFloor("2026-07-30")).toBe("2026-07-30");
    expect(resolveBankFeedFloor("2026-07-30T12:09:26Z")).toBe("2026-07-30");
  });

  it("applyBankFeedFloor: rows dated BEFORE the floor are skipped, go-live day and after pass", () => {
    const rows = [tx("2025-04-01"), tx("2026-07-29"), tx("2026-07-30"), tx("2026-08-01")];
    const kept = applyBankFeedFloor(rows, "2026-07-30").map((r) => r.txDate);
    expect(kept).toEqual(["2026-07-30", "2026-08-01"]); // floor is inclusive of go-live day
  });

  it("applyBankFeedFloor: a null floor is a no-op — every row passes (safe before the env is set)", () => {
    const rows = [tx("2025-04-01"), tx("2026-07-30")];
    expect(applyBankFeedFloor(rows, null)).toEqual(rows);
  });
});

/* ------------------------------------------------------------ match */

const open = (over: Partial<OpenItem>): OpenItem => ({
  quoteId: "q1",
  quoteRef: "MMR001",
  leadId: "l1",
  customer: "Jane Smith",
  amount: 100,
  kind: "deposit",
  ...over,
});

describe("matchTransaction — a suggestion REQUIRES the exact amount", () => {
  it("reference + exact amount → confirmable suggestion carrying the item amount", () => {
    const m = matchTransaction(
      { amount: 100, reference: "MMR001-DEP", description: null },
      [open({}), open({ quoteId: "q2", quoteRef: "MMR002" })],
    );
    expect(m).toMatchObject({
      type: "suggestion",
      kind: "deposit",
      confidence: "reference",
      quoteId: "q1",
      amount: 100,
    });
  });

  it("CRITICAL regression: right quote, WRONG amount → mismatch, never a suggestion", () => {
    // £500 part-payment against the only open item (a £1,100 balance):
    const m = matchTransaction(
      { amount: 500, reference: "MMR001", description: null },
      [open({ kind: "balance", amount: 1100 })],
    );
    expect(m).toMatchObject({ type: "mismatch", kind: "balance", quoteId: "q1", quoteRef: "MMR001" });
    // Even with the -DEP suffix, a duplicate deposit against an open balance
    // must not be confirmable as the balance:
    const dup = matchTransaction(
      { amount: 100, reference: "MMR001-DEP", description: null },
      [open({ kind: "balance", amount: 1100 })],
    );
    expect(dup?.type).toBe("mismatch");
  });

  it("same quote with deposit AND balance open: exact amount picks; suffix breaks same-amount ties", () => {
    const items = [
      open({ kind: "deposit", amount: 100 }),
      open({ quoteId: "q1b", kind: "balance", amount: 920 }),
    ];
    expect(matchTransaction({ amount: 920, reference: "MMR001-BAL", description: null }, items))
      .toMatchObject({ type: "suggestion", kind: "balance", quoteId: "q1b", amount: 920 });
    expect(matchTransaction({ amount: 100, reference: "MMR001", description: null }, items))
      .toMatchObject({ type: "suggestion", kind: "deposit", amount: 100 });
    // £55 matches neither open amount → mismatch for a human:
    expect(matchTransaction({ amount: 55, reference: "MMR001", description: null }, items))
      .toMatchObject({ type: "mismatch" });
  });

  it("legacy MM-YYMMDD-NNN refs still match", () => {
    const m = matchTransaction(
      { amount: 100, reference: "MM-260708-009", description: null },
      [open({ quoteRef: "MM-260708-009" })],
    );
    expect(m).toMatchObject({ type: "suggestion", quoteId: "q1" });
  });

  it("a referenced quote that is NOT open matches nothing (human territory)", () => {
    expect(
      matchTransaction({ amount: 100, reference: "MMR999", description: null }, [open({})]),
    ).toBeNull();
  });

  it("amount-only needs BOTH a unique amount AND a corroborating payer name", () => {
    const items = [open({}), open({ quoteId: "q2", quoteRef: "MMR002", amount: 100 })];
    // ambiguous amount (two open £100) → never, whatever the name:
    expect(
      matchTransaction({ amount: 100, reference: "moving money", description: null, counterparty: "Jane Smith" }, items),
    ).toBeNull();
    // unique amount + the payer name matches the customer → confirmable:
    expect(
      matchTransaction({ amount: 920, reference: null, description: null, counterparty: "JANE SMITH" }, [
        open({ kind: "balance", amount: 920 }),
      ]),
    ).toMatchObject({ type: "suggestion", confidence: "amount", kind: "balance" });
    // a shortened bank name still corroborates on the surname:
    expect(
      matchTransaction({ amount: 920, reference: null, description: null, counterparty: "J SMITH" }, [
        open({ kind: "balance", amount: 920 }),
      ]),
    ).toMatchObject({ type: "suggestion", confidence: "amount" });
  });

  it("amount-only from an UNRELATED payer is never a suggestion (2026-07-31 Dingley regression)", () => {
    // A stranger's £100 must NOT one-tap-match someone else's £100 deposit.
    expect(
      matchTransaction({ amount: 100, reference: "Dingley", description: null, counterparty: "E Dingley" }, [
        open({ customer: "Rebecca Eldred" }),
      ]),
    ).toBeNull();
    // a missing payer name can't corroborate either — fail safe:
    expect(
      matchTransaction({ amount: 100, reference: null, description: null, counterparty: null }, [open({})]),
    ).toBeNull();
  });

  it("reference is typo-tolerant: an O-for-0 quote ref matches BY REFERENCE (2026-07-31 MMRO17)", () => {
    // "MMRO17" (letter O) is how the customer keyed MMR017 — it must ref-match,
    // not fall through to the weak amount-only path.
    const m = matchTransaction(
      { amount: 100, reference: "MMRO17", description: null, counterparty: "ELDRED R A" },
      [open({ quoteRef: "MMR017", customer: "Rebecca Eldred" })],
    );
    expect(m).toMatchObject({ type: "suggestion", confidence: "reference", quoteRef: "MMR017" });
    // refsInText itself normalises the lookalikes, and the strict form is unaffected:
    expect(refsInText("MMRO17", null)).toEqual(["MMR017"]);
    expect(refsInText("MMR017-DEP", null)).toEqual(["MMR017"]);
  });

  it("storage references are tagged storage, not quote-matched", () => {
    const m = matchTransaction(
      { amount: 25, reference: "MMS-1A2B3C4D-2026-07", description: null },
      [open({})],
    );
    expect(m).toEqual({ type: "storage" });
  });

  it("refsInText dedupes across reference + description", () => {
    expect(refsInText("MMR001-DEP", "JANE MMR001 dep")).toEqual(["MMR001"]);
  });
});
