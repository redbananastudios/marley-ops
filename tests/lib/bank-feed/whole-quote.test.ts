import { describe, expect, it } from "vitest";
import { describeKinds, wholeQuoteLinks, type SettledLike } from "@/lib/bank-feed/whole-quote";

const item = (over: Partial<SettledLike>): SettledLike => ({
  quoteId: "q1",
  quoteRef: "IMV012",
  customer: "Kayleigh",
  kind: "deposit",
  amount: 100,
  ...over,
});

describe("wholeQuoteLinks", () => {
  it("the live case: one GBP660 transfer pays a job recorded as 100 + 560", () => {
    // IMV012 was imported already paid with a blanket 100 deposit, so neither
    // settled item equals the real transfer and the office had nothing to pick.
    const links = wholeQuoteLinks(
      [item({ kind: "deposit", amount: 100 }), item({ kind: "balance", amount: 560 })],
      66000,
    );
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ quoteId: "q1", quoteRef: "IMV012", amount: 660 });
    expect(links[0].kinds).toEqual(["deposit", "balance"]);
  });

  it("a single settled item is NOT offered - the per-item path already has it", () => {
    expect(wholeQuoteLinks([item({ kind: "balance", amount: 660 })], 66000)).toEqual([]);
  });

  it("refuses anything that is not exact to the penny", () => {
    const items = [item({ kind: "deposit", amount: 100 }), item({ kind: "balance", amount: 560 })];
    expect(wholeQuoteLinks(items, 65999)).toEqual([]);
    expect(wholeQuoteLinks(items, 66001)).toEqual([]);
  });

  it("sums in pennies, so figures that misbehave in floating point still match", () => {
    // 2806.13 = 100 + 2706.13; adding those as floats gives 2806.1299999999997.
    const links = wholeQuoteLinks(
      [item({ kind: "deposit", amount: 100 }), item({ kind: "balance", amount: 2706.13 })],
      280613,
    );
    expect(links).toHaveLength(1);
    expect(links[0].amount).toBe(2806.13);
  });

  it("handles all three kinds and reports them in ledger order", () => {
    const links = wholeQuoteLinks(
      [
        item({ kind: "balance", amount: 400 }),
        item({ kind: "deposit", amount: 100 }),
        item({ kind: "commitment", amount: 160 }),
      ],
      66000,
    );
    expect(links[0].kinds).toEqual(["deposit", "commitment", "balance"]);
  });

  it("only the quote that actually sums to the transfer is offered", () => {
    const links = wholeQuoteLinks(
      [
        item({ quoteId: "a", quoteRef: "IMV012", kind: "deposit", amount: 100 }),
        item({ quoteId: "a", quoteRef: "IMV012", kind: "balance", amount: 560 }),
        item({ quoteId: "b", quoteRef: "IMV099", kind: "deposit", amount: 100 }),
        item({ quoteId: "b", quoteRef: "IMV099", kind: "balance", amount: 900 }),
      ],
      66000,
    );
    expect(links.map((l) => l.quoteRef)).toEqual(["IMV012"]);
  });

  it("two quotes that both sum to the transfer are BOTH offered - ambiguity is the office's to resolve, never ours to guess", () => {
    const links = wholeQuoteLinks(
      [
        item({ quoteId: "b", quoteRef: "IMV099", kind: "deposit", amount: 60 }),
        item({ quoteId: "b", quoteRef: "IMV099", kind: "balance", amount: 600 }),
        item({ quoteId: "a", quoteRef: "IMV012", kind: "deposit", amount: 100 }),
        item({ quoteId: "a", quoteRef: "IMV012", kind: "balance", amount: 560 }),
      ],
      66000,
    );
    expect(links.map((l) => l.quoteRef)).toEqual(["IMV012", "IMV099"]);
  });

  it("nonsense transfer amounts yield nothing rather than throwing", () => {
    const items = [item({ kind: "deposit", amount: 100 }), item({ kind: "balance", amount: 560 })];
    expect(wholeQuoteLinks(items, 0)).toEqual([]);
    expect(wholeQuoteLinks(items, -66000)).toEqual([]);
    expect(wholeQuoteLinks(items, Number.NaN)).toEqual([]);
    expect(wholeQuoteLinks([], 66000)).toEqual([]);
  });

  it("describes the set the way the office reads it", () => {
    expect(describeKinds(["deposit", "balance"])).toBe("deposit + balance");
  });
});
