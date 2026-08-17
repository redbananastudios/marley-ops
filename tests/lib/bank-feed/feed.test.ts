import { describe, expect, it } from "vitest";
import {
  applyBankFeedFloor,
  isAcquirerSettlement,
  isInboundPayment,
  parseAmount,
  parseSheetRows,
  resolveBankFeedFloor,
  ukDateToIso,
  type BankTxRow,
} from "@/lib/bank-feed/parse";
import {
  matchTransaction,
  matchTransactionLedger,
  reconcileSettled,
  refsInText,
  suggestSettledLink,
  type OpenItem,
  type SettledItem,
} from "@/lib/bank-feed/match";

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

describe("isAcquirerSettlement (Elavon/takepayments payouts are not customer money)", () => {
  it("recognises the real Elavon payout shape (counterparty + EMS reference)", () => {
    // The live row that sat in "Unmatched inbound" on 2026-08-05.
    expect(
      isAcquirerSettlement({ counterparty: "US Bank Europe Dac", reference: "EMS723080500083798" }),
    ).toBe(true);
  });

  it("recognises by counterparty alone (reference renamed or blank)", () => {
    expect(isAcquirerSettlement({ counterparty: "US BANK EUROPE DAC", reference: null })).toBe(true);
    expect(isAcquirerSettlement({ counterparty: "Elavon Financial Services", reference: "payout" })).toBe(true);
  });

  it("recognises by EMS reference alone (counterparty display name changed)", () => {
    expect(isAcquirerSettlement({ counterparty: "Settlement", reference: "EMS723080600091234" })).toBe(true);
  });

  it("never fires on ordinary customers", () => {
    // A customer transfer with a quote ref.
    expect(isAcquirerSettlement({ counterparty: "JANE SMITH", reference: "MMR001-DEP" })).toBe(false);
    // A surname that contains 'ems' letters, and an EMS-ish word with no digits.
    expect(isAcquirerSettlement({ counterparty: "P EMSWORTH", reference: "EMSWORTH REMOVAL" })).toBe(false);
    // "bank" in a customer's own name is not the acquirer.
    expect(isAcquirerSettlement({ counterparty: "Eleanor Banks", reference: "deposit" })).toBe(false);
    expect(isAcquirerSettlement({ counterparty: null, reference: null })).toBe(false);
  });
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

describe("matchTransaction — commitment invoices (2026-08-06 MY SAFETY LTD £50)", () => {
  // The real gap: MMR034's £50 commitment top-up read as a part-payment
  // mismatch against the balance because the matcher had no commitment kind.
  // £600 agreed, £100 deposit paid, £50 commitment RAISED — loadOpenItems
  // nets the raised commitment out of the balance (invoices partition the
  // agreed price), so the open set is commitment £50 + balance £450, which
  // sums to exactly what the customer still owes.
  const mmr034 = [
    open({ quoteId: "q34", quoteRef: "MMR034", customer: "Brydee Thomas", kind: "balance", amount: 450 }),
    open({ quoteId: "q34", quoteRef: "MMR034", customer: "Brydee Thomas", kind: "commitment", amount: 50 }),
  ];

  it("reference + exact commitment amount → confirmable commitment suggestion", () => {
    expect(matchTransaction({ amount: 50, reference: "MMR034", description: null }, mmr034)).toMatchObject({
      type: "suggestion",
      kind: "commitment",
      confidence: "reference",
      quoteId: "q34",
      amount: 50,
    });
  });

  it("the netted balance amount picks the balance on the same quote", () => {
    expect(matchTransaction({ amount: 450, reference: "MMR034", description: null }, mmr034)).toMatchObject({
      type: "suggestion",
      kind: "balance",
      amount: 450,
    });
  });

  it("the GROSS (un-netted) balance figure matches neither item — human territory, never one-tap", () => {
    // £500 would double-pay the commitment; it must never one-tap-record.
    expect(matchTransaction({ amount: 500, reference: "MMR034", description: null }, mmr034)).toMatchObject({
      type: "mismatch",
      quoteRef: "MMR034",
    });
  });

  it("an amount matching NEITHER open item stays a mismatch", () => {
    expect(matchTransaction({ amount: 75, reference: "MMR034", description: null }, mmr034)).toMatchObject({
      type: "mismatch",
      quoteRef: "MMR034",
    });
  });

  it("the Zoho -COM suffix breaks a same-amount tie in the commitment's favour", () => {
    const tied = [
      open({ kind: "deposit", amount: 100 }),
      open({ kind: "commitment", amount: 100 }),
    ];
    expect(matchTransaction({ amount: 100, reference: "MMR001-COM", description: null }, tied)).toMatchObject({
      type: "suggestion",
      kind: "commitment",
    });
    // suffix-less keeps today's deposit-first pick (open-items order):
    expect(matchTransaction({ amount: 100, reference: "MMR001", description: null }, tied)).toMatchObject({
      type: "suggestion",
      kind: "deposit",
    });
  });

  it("amount-only with a corroborating payer name can suggest a commitment", () => {
    expect(
      matchTransaction(
        { amount: 50, reference: "for the move", description: null, counterparty: "B THOMAS" },
        [open({ kind: "commitment", amount: 50, customer: "Brydee Thomas" })],
      ),
    ).toMatchObject({ type: "suggestion", kind: "commitment", confidence: "amount" });
  });

  it("a same-amount commitment on an UNRELATED quote must not blind an amount-only match the name resolves", () => {
    // £800 jobs open £100 commitments, colliding with the standard £100
    // deposit. Corroboration-first: the payer's surname picks Jane's deposit.
    const pool = [
      open({ kind: "deposit", amount: 100, customer: "Jane Smith" }),
      open({ quoteId: "q9", quoteRef: "MMR009", kind: "commitment", amount: 100, customer: "Brydee Thomas" }),
    ];
    expect(
      matchTransaction({ amount: 100, reference: null, description: null, counterparty: "J SMITH" }, pool),
    ).toMatchObject({ type: "suggestion", kind: "deposit", quoteId: "q1", confidence: "amount" });
    // A stranger corroborates neither — still unmatched for a human:
    expect(
      matchTransaction({ amount: 100, reference: null, description: null, counterparty: "E Dingley" }, pool),
    ).toBeNull();
  });
});

/* ------------------------------------------------- settled reconcile */

const settledItem = (over: Partial<SettledItem>): SettledItem => ({
  quoteId: "q34",
  quoteRef: "MMR034",
  leadId: "l34",
  customer: "Brydee Thomas",
  amount: 450,
  kind: "balance",
  ...over,
});

describe("reconcileSettled — payment recorded before its bank row (2026-08-16 Brydee MMR034)", () => {
  it("the live case: 'MMR034-BAL' £450 after the balance was recorded via Zoho → reconciled", () => {
    // Balance marked paid 15 Aug via the Zoho poll; the 14 Aug transfer could
    // never match the OPEN set and sat in Unmatched inbound forever.
    expect(
      reconcileSettled(
        { amount: 450, reference: "MMR034-BAL", description: null, counterparty: "MY SAFETY LTD" },
        [settledItem({})],
      ),
    ).toEqual({ type: "reconciled", kind: "balance", quoteId: "q34", quoteRef: "MMR034" });
  });

  it("reference + WRONG amount does not reconcile — that money is genuinely unexplained", () => {
    expect(
      reconcileSettled({ amount: 400, reference: "MMR034-BAL", description: null }, [settledItem({})]),
    ).toBeNull();
  });

  it("amount alone never reconciles — no reference, no auto-explain, whatever the payer name", () => {
    expect(
      reconcileSettled(
        { amount: 450, reference: "moving money", description: null, counterparty: "B THOMAS" },
        [settledItem({})],
      ),
    ).toBeNull();
  });

  it("the suffix picks between same-amount settled items on one quote", () => {
    const pool = [
      settledItem({ kind: "deposit", amount: 100 }),
      settledItem({ kind: "commitment", amount: 100 }),
    ];
    expect(reconcileSettled({ amount: 100, reference: "MMR034-COM", description: null }, pool)).toMatchObject({
      kind: "commitment",
    });
    expect(reconcileSettled({ amount: 100, reference: "MMR034-DEP", description: null }, pool)).toMatchObject({
      kind: "deposit",
    });
  });
});

describe("suggestSettledLink — the unmatched queue stops pretending it can't see the twin", () => {
  const dingley = settledItem({
    quoteId: "qD",
    quoteRef: "IMV018",
    leadId: "lD",
    customer: "Emma Dingley",
    amount: 1100,
    kind: "balance",
  });

  it("the live case: 'DINGLEY' £1,100 against Emma Dingley's recorded £1,100 balance", () => {
    expect(
      suggestSettledLink(
        { amount: 1100, reference: "DINGLEY", description: null, counterparty: "E Dingley" },
        [dingley],
      ),
    ).toEqual(dingley);
  });

  it("the name can live in the REFERENCE alone — a bare 'DINGLEY' from a third-party payer still hints", () => {
    expect(
      suggestSettledLink(
        { amount: 1100, reference: "DINGLEY", description: null, counterparty: "MY SAFETY LTD" },
        [dingley],
      ),
    ).toEqual(dingley);
  });

  it("no name overlap → no hint, however neatly the amount lines up", () => {
    expect(
      suggestSettledLink(
        { amount: 1100, reference: "invoice payment", description: null, counterparty: "J SMITH" },
        [dingley],
      ),
    ).toBeNull();
  });

  it("two corroborating candidates stay ambiguous — a guess between them is worse than none", () => {
    const twin = settledItem({ quoteId: "qD2", quoteRef: "IMV019", customer: "Emma Dingley", amount: 1100 });
    expect(
      suggestSettledLink({ amount: 1100, reference: "DINGLEY", description: null }, [dingley, twin]),
    ).toBeNull();
  });

  it("a row that NAMES a quote is the auto path's business — never hinted here", () => {
    // If it named MMR034 and didn't reconcile, the amounts genuinely differ:
    // hinting a link at the wrong amount would invite a false reconcile.
    expect(
      suggestSettledLink(
        { amount: 1100, reference: "MMR034 DINGLEY", description: null, counterparty: "E Dingley" },
        [dingley],
      ),
    ).toBeNull();
  });

  it("the amount must be exact to the penny", () => {
    expect(
      suggestSettledLink({ amount: 1099.99, reference: "DINGLEY", description: null }, [dingley]),
    ).toBeNull();
  });

  it("generic words are not identity — 'LTD' shared with a company customer proves nothing", () => {
    const company = settledItem({ customer: "My Safety Ltd", amount: 1100, kind: "balance" });
    expect(
      suggestSettledLink(
        { amount: 1100, reference: "PAYMENT FOR MOVE", description: null, counterparty: "ACME LTD" },
        [company],
      ),
    ).toBeNull();
  });
});

describe("matchTransactionLedger — open items keep primacy, settled explains the leftovers", () => {
  it("an open suggestion wins over a settled twin (real open money wants recording)", () => {
    const result = matchTransactionLedger(
      { amount: 100, reference: "MMR034", description: null },
      [open({ quoteId: "q34", quoteRef: "MMR034", kind: "deposit", amount: 100 })],
      [settledItem({ kind: "commitment", amount: 100 })],
    );
    expect(result).toMatchObject({ type: "suggestion", kind: "deposit" });
  });

  it("reconcile beats a MISMATCH: a late deposit row must not read as a part-payment of the balance", () => {
    // Open balance £1,100; the £100 transfer is the deposit, recorded days ago.
    const result = matchTransactionLedger(
      { amount: 100, reference: "MMR034", description: null },
      [open({ quoteId: "q34", quoteRef: "MMR034", kind: "balance", amount: 1100 })],
      [settledItem({ kind: "deposit", amount: 100 })],
    );
    expect(result).toMatchObject({ type: "reconciled", kind: "deposit" });
  });

  it("an explicit suffix naming the SETTLED kind beats a same-amount suggestion for a DIFFERENT kind", () => {
    // '-BAL' after the balance was recorded, while an open commitment happens
    // to share the amount: suggesting the commitment would invite the office
    // to one-tap-record the same £450 twice (the Kong double-bill shape).
    const result = matchTransactionLedger(
      { amount: 450, reference: "MMR034-BAL", description: null },
      [open({ quoteId: "q34", quoteRef: "MMR034", kind: "commitment", amount: 450 })],
      [settledItem({ kind: "balance", amount: 450 })],
    );
    expect(result).toMatchObject({ type: "reconciled", kind: "balance" });
  });

  it("nothing open, nothing settled → null (unmatched, human territory)", () => {
    expect(
      matchTransactionLedger({ amount: 450, reference: "MMR999", description: null }, [open({})], [
        settledItem({}),
      ]),
    ).toBeNull();
  });

  it("storage references stay storage even with a settled twin", () => {
    expect(
      matchTransactionLedger({ amount: 25, reference: "MMS-1A2B3C4D", description: null }, [], [
        settledItem({ amount: 25 }),
      ]),
    ).toEqual({ type: "storage" });
  });
});
