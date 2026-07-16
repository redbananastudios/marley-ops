import { describe, expect, it } from "vitest";
import { isInboundPayment, parseSheetRows, ukDateToIso } from "@/lib/bank-feed/parse";
import { matchTransaction, refsInText, type OpenItem } from "@/lib/bank-feed/match";

/* ------------------------------------------------------------ parse */

const HEADERS = [
  "Transaction ID", "Date", "Time", "Type", "Name", "Emoji", "Category", "Amount",
  "Currency", "Local amount", "Local currency", "Notes and #tags", "Address",
  "Receipt", "Description", "Category split", "Pot name",
];

const row = (over: Partial<Record<string, string>>): string[] =>
  HEADERS.map((h) =>
    ({
      "Transaction ID": "tx_0000Abc",
      Date: "16/07/2026",
      Time: "10:15:00",
      Type: "Faster payment",
      Name: "JANE SMITH",
      Amount: "100.00",
      Currency: "GBP",
      "Notes and #tags": "MMR001-DEP",
      Description: "JANE SMITH MMR001-DEP",
      ...over,
    })[h] ?? "",
  );

describe("parseSheetRows (Monzo export)", () => {
  it("maps by header name and converts UK dates", () => {
    const rows = parseSheetRows([HEADERS, row({})]);
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

  it("skips malformed rows (no id / bad date / non-numeric amount)", () => {
    const rows = parseSheetRows([
      HEADERS,
      row({ "Transaction ID": "" }),
      row({ Date: "2026-07-16" }), // ISO in a DD/MM/YYYY column = malformed
      row({ Amount: "one hundred" }),
      row({ "Transaction ID": "tx_ok" }),
    ]);
    expect(rows.map((r) => r.transactionId)).toEqual(["tx_ok"]);
  });

  it("refuses entirely if the schema drifted (headers missing)", () => {
    expect(parseSheetRows([["Something", "Else"], ["a", "b"]])).toEqual([]);
  });

  it("ukDateToIso handles boundaries", () => {
    expect(ukDateToIso("01/06/2026")).toBe("2026-06-01");
    expect(ukDateToIso("31/12/2025")).toBe("2025-12-31");
    expect(ukDateToIso("2026-06-01")).toBeNull();
    expect(ukDateToIso("")).toBeNull();
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

describe("matchTransaction", () => {
  it("matches a -DEP reference to the deposit", () => {
    const m = matchTransaction(
      { amount: 100, reference: "MMR001-DEP", description: null },
      [open({}), open({ quoteId: "q2", quoteRef: "MMR002" })],
    );
    expect(m).toMatchObject({ kind: "deposit", confidence: "reference", quoteId: "q1" });
  });

  it("matches a bare quote ref case-insensitively from the description", () => {
    const m = matchTransaction(
      { amount: 920, reference: null, description: "payment mmc014 balance" },
      [open({ quoteId: "q3", quoteRef: "MMC014", kind: "balance", amount: 920 })],
    );
    expect(m).toMatchObject({ kind: "balance", confidence: "reference", quoteId: "q3" });
  });

  it("legacy MM-YYMMDD-NNN refs still match", () => {
    const m = matchTransaction(
      { amount: 100, reference: "MM-260708-009", description: null },
      [open({ quoteRef: "MM-260708-009" })],
    );
    expect(m).toMatchObject({ kind: "deposit", quoteId: "q1" });
  });

  it("same quote with deposit AND balance open: suffix picks; else exact amount picks", () => {
    const items = [
      open({ kind: "deposit", amount: 100 }),
      open({ quoteId: "q1b", kind: "balance", amount: 920 }),
    ];
    expect(matchTransaction({ amount: 920, reference: "MMR001-BAL", description: null }, items))
      .toMatchObject({ kind: "balance", quoteId: "q1b" });
    expect(matchTransaction({ amount: 920, reference: "MMR001", description: null }, items))
      .toMatchObject({ kind: "balance", quoteId: "q1b" }); // amount disambiguates
    expect(matchTransaction({ amount: 55, reference: "MMR001", description: null }, items))
      .toMatchObject({ kind: "deposit" }); // odd amount → deposit preferred
  });

  it("a referenced quote that is NOT open matches nothing (human territory)", () => {
    expect(
      matchTransaction({ amount: 100, reference: "MMR999", description: null }, [open({})]),
    ).toBeNull();
  });

  it("amount-only matches ONLY when unambiguous", () => {
    const items = [open({}), open({ quoteId: "q2", quoteRef: "MMR002", amount: 100 })];
    expect(matchTransaction({ amount: 100, reference: "moving money", description: null }, items)).toBeNull();
    expect(
      matchTransaction({ amount: 920, reference: null, description: null }, [
        open({ kind: "balance", amount: 920 }),
      ]),
    ).toMatchObject({ confidence: "amount", kind: "balance" });
  });

  it("storage references are tagged storage, not quote-matched", () => {
    const m = matchTransaction(
      { amount: 25, reference: "MMS-1A2B3C4D-2026-07", description: null },
      [open({})],
    );
    expect(m).toMatchObject({ kind: "storage", confidence: "reference", quoteId: null });
  });

  it("refsInText dedupes across reference + description", () => {
    expect(refsInText("MMR001-DEP", "JANE MMR001 dep")).toEqual(["MMR001"]);
  });
});
