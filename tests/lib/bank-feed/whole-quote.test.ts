import { describe, expect, it } from "vitest";
import {
  coveringPairLinks,
  describeKinds,
  wholeQuoteLinks,
  type OpenLike,
  type SettledLike,
} from "@/lib/bank-feed/whole-quote";

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

const openItem = (over: Partial<OpenLike>): OpenLike => ({
  quoteId: "q1",
  quoteRef: "MMR112",
  customer: "Greig",
  kind: "commitment",
  amount: 400,
  ...over,
});

describe("coveringPairLinks", () => {
  it("the settle-in-full case: deposit recorded, one transfer covers the open commitment + balance", () => {
    // Gate 9c tells the customer to send commitment + balance in ONE transfer
    // (£400 + £1,500 = £1,900). The deposit is already SETTLED so it is not in
    // the open pool — the pair must be explainable without it.
    const links = coveringPairLinks(
      [openItem({ kind: "commitment", amount: 400 }), openItem({ kind: "balance", amount: 1500 })],
      190000,
    );
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      quoteId: "q1",
      quoteRef: "MMR112",
      commitmentAmount: 400,
      balanceAmount: 1500,
      amount: 1900,
    });
    expect(links[0].kinds).toEqual(["commitment", "balance"]);
  });

  it("off by a penny either way yields nothing", () => {
    const open = [openItem({ kind: "commitment", amount: 400 }), openItem({ kind: "balance", amount: 1500 })];
    expect(coveringPairLinks(open, 189999)).toEqual([]);
    expect(coveringPairLinks(open, 190001)).toEqual([]);
  });

  it("ambiguity yields nothing: two open items of the same kind on one quote never form a pair", () => {
    // Should be impossible by construction (one commitment column per quote),
    // but if it ever happens there are two candidate pairs — no suggestion.
    const links = coveringPairLinks(
      [
        openItem({ kind: "commitment", amount: 400 }),
        openItem({ kind: "commitment", amount: 300 }),
        openItem({ kind: "balance", amount: 1500 }),
      ],
      190000,
    );
    expect(links).toEqual([]);
  });

  it("an open deposit never forms a pair — this is strictly the commitment + balance shape", () => {
    expect(
      coveringPairLinks(
        [openItem({ kind: "deposit", amount: 400 }), openItem({ kind: "balance", amount: 1500 })],
        190000,
      ),
    ).toEqual([]);
    // Nor does the deposit's presence widen the pair into a three-item subset.
    expect(
      coveringPairLinks(
        [
          openItem({ kind: "deposit", amount: 100 }),
          openItem({ kind: "commitment", amount: 400 }),
          openItem({ kind: "balance", amount: 1400 }),
        ],
        190000,
      ),
    ).toEqual([]);
  });

  it("a lone open commitment or balance is the per-item path's territory", () => {
    expect(coveringPairLinks([openItem({ kind: "commitment", amount: 1900 })], 190000)).toEqual([]);
    expect(coveringPairLinks([openItem({ kind: "balance", amount: 1900 })], 190000)).toEqual([]);
  });

  it("sums in pennies, so figures that misbehave in floating point still match", () => {
    // 2806.13 = 100 + 2706.13; adding those as floats gives 2806.1299999999997.
    const links = coveringPairLinks(
      [openItem({ kind: "commitment", amount: 100 }), openItem({ kind: "balance", amount: 2706.13 })],
      280613,
    );
    expect(links).toHaveLength(1);
    expect(links[0].amount).toBe(2806.13);
  });

  it("only the quote whose pair sums is offered; two quotes that both sum are BOTH offered for the office to resolve", () => {
    const open = [
      openItem({ quoteId: "b", quoteRef: "MMR200", kind: "commitment", amount: 900 }),
      openItem({ quoteId: "b", quoteRef: "MMR200", kind: "balance", amount: 1000 }),
      openItem({ quoteId: "a", quoteRef: "MMR112", kind: "commitment", amount: 400 }),
      openItem({ quoteId: "a", quoteRef: "MMR112", kind: "balance", amount: 1500 }),
      openItem({ quoteId: "c", quoteRef: "MMR300", kind: "commitment", amount: 400 }),
      openItem({ quoteId: "c", quoteRef: "MMR300", kind: "balance", amount: 900 }),
    ];
    expect(coveringPairLinks(open, 190000).map((l) => l.quoteRef)).toEqual(["MMR112", "MMR200"]);
  });

  it("nonsense transfer amounts yield nothing rather than throwing", () => {
    const open = [openItem({ kind: "commitment", amount: 400 }), openItem({ kind: "balance", amount: 1500 })];
    expect(coveringPairLinks(open, 0)).toEqual([]);
    expect(coveringPairLinks(open, -190000)).toEqual([]);
    expect(coveringPairLinks(open, Number.NaN)).toEqual([]);
    expect(coveringPairLinks([], 190000)).toEqual([]);
  });

  it("a zero-amount half never forms a pair — that is a disguised single item", () => {
    expect(
      coveringPairLinks(
        [openItem({ kind: "commitment", amount: 0 }), openItem({ kind: "balance", amount: 1900 })],
        190000,
      ),
    ).toEqual([]);
  });
});
