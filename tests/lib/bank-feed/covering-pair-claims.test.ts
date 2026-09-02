import { describe, expect, it } from "vitest";
import { buildClaimedKeys, type ClaimingRow } from "@/lib/bank-feed/sync";
import { claimKey, reconcileSettled, type SettledItem } from "@/lib/bank-feed/match";
import { coveringPairPartner } from "@/lib/bank-feed/whole-quote";

/**
 * Money that has been RECORDED must be in the claimed set.
 *
 * `claimed` is the only thing standing between a second transfer for an
 * already-paid item and `reconcileSettled` filing it as "explained" — no human
 * tap, no queue, no exceptions strip, and the received ledger de-dupes it away.
 * Two shapes were under-claimed, and an under-claim here loses a refund we owe
 * on every surface at once:
 *
 *  - a covering-pair confirm records TWO payments but a bank row carries ONE
 *    `match_kind`, so the unstamped half was claimed by nothing (MMR112: the
 *    £1,900 settle-in-full lands, then the customer's standing £400 commitment
 *    arrives and auto-reconciles);
 *  - a whole-job link is stamped 'full', which keyed `quote:full` and therefore
 *    matched no settled kind at all — a whole-job-linked quote claimed NOTHING,
 *    even though `healMissingPaidMethods` and the received ledger both already
 *    read 'full' as all three.
 */

const QUOTE = "quote-mmr112";
const REF = "MMR112";

const settledItem = (over: Partial<SettledItem>): SettledItem => ({
  quoteId: QUOTE,
  quoteRef: REF,
  leadId: "lead-1",
  customer: "Greig James",
  kind: "commitment",
  amount: 400,
  ...over,
});

/** MMR112 after a settle-in-full confirm: deposit, commitment and balance all
 *  recorded, the £1,900 transfer stamped with one half of the pair. */
const SETTLED_AFTER_PAIR: SettledItem[] = [
  settledItem({ kind: "deposit", amount: 100 }),
  settledItem({ kind: "commitment", amount: 400 }),
  settledItem({ kind: "balance", amount: 1500 }),
];

const row = (over: Partial<ClaimingRow>): ClaimingRow => ({
  status: "confirmed",
  matchedQuoteId: QUOTE,
  matchKind: "balance",
  amount: 1900,
  ...over,
});

/** The customer's earlier standing order for the commitment, landing after the
 *  covering transfer already paid it. */
const duplicateCommitmentTx = {
  amount: 400,
  reference: "MMR112",
  description: null,
  counterparty: "G JAMES",
};

describe("buildClaimedKeys — parity with the single-stamp rows it already handled", () => {
  it("claims the stamped kind of a confirmed row", () => {
    const claimed = buildClaimedKeys([row({ matchKind: "deposit", amount: 100 })], {
      open: [],
      settled: SETTLED_AFTER_PAIR,
    });
    expect(claimed.has(claimKey(QUOTE, "deposit"))).toBe(true);
    expect(claimed.has(claimKey(QUOTE, "balance"))).toBe(false);
  });

  it("ignores rows the office has not settled, and rows pointing at nothing", () => {
    const claimed = buildClaimedKeys(
      [
        row({ status: "unmatched", matchKind: "deposit", amount: 100 }),
        row({ status: "suggested", matchKind: "deposit", amount: 100 }),
        row({ status: "dismissed", matchKind: "deposit", amount: 100 }),
        row({ matchedQuoteId: null, matchKind: null }),
      ],
      { open: [], settled: SETTLED_AFTER_PAIR },
    );
    expect(claimed.size).toBe(0);
  });

  it("a storage row claims no quote payment", () => {
    const claimed = buildClaimedKeys([row({ matchKind: "storage", amount: 60 })], {
      open: [],
      settled: SETTLED_AFTER_PAIR,
    });
    expect(claimed.size).toBe(0);
  });
});

describe("a covering-pair row claims BOTH payments it recorded", () => {
  it("claims the commitment the 'balance' stamp leaves out", () => {
    const claimed = buildClaimedKeys([row({})], { open: [], settled: SETTLED_AFTER_PAIR });
    expect(claimed.has(claimKey(QUOTE, "balance"))).toBe(true);
    expect(claimed.has(claimKey(QUOTE, "commitment"))).toBe(true);
    // The deposit was a separate transfer — the pair never claims it.
    expect(claimed.has(claimKey(QUOTE, "deposit"))).toBe(false);
  });

  it("so the customer's duplicate £400 parks for a human instead of auto-reconciling", () => {
    const claimed = buildClaimedKeys([row({})], { open: [], settled: SETTLED_AFTER_PAIR });
    expect(reconcileSettled(duplicateCommitmentTx, SETTLED_AFTER_PAIR, claimed)).toEqual({
      type: "duplicate",
      kind: "commitment",
      quoteId: QUOTE,
      quoteRef: REF,
    });
  });

  it("claims the balance when the row kept the 'commitment' stamp instead", () => {
    // The re-stamp to 'balance' is best-effort; a failed one leaves the row on
    // the claim it took first, and that must protect the pair just as well.
    const claimed = buildClaimedKeys([row({ matchKind: "commitment" })], {
      open: [],
      settled: SETTLED_AFTER_PAIR,
    });
    expect(claimed.has(claimKey(QUOTE, "commitment"))).toBe(true);
    expect(claimed.has(claimKey(QUOTE, "balance"))).toBe(true);
  });

  it("a single-item row at the same amount is NOT read as a pair", () => {
    // Confirm/attach/link all bind a row's amount to ONE item's amount exactly,
    // so a £1,500 balance row must keep claiming only the balance.
    const claimed = buildClaimedKeys([row({ amount: 1500 })], {
      open: [],
      settled: SETTLED_AFTER_PAIR,
    });
    expect(claimed.has(claimKey(QUOTE, "balance"))).toBe(true);
    expect(claimed.has(claimKey(QUOTE, "commitment"))).toBe(false);
  });

  it("ambiguity yields nothing — two commitments on a quote form no pair", () => {
    const claimed = buildClaimedKeys([row({})], {
      open: [],
      settled: [
        ...SETTLED_AFTER_PAIR,
        settledItem({ kind: "commitment", amount: 400, quoteRef: "MMR112" }),
      ],
    });
    expect(claimed.has(claimKey(QUOTE, "balance"))).toBe(true);
    expect(claimed.has(claimKey(QUOTE, "commitment"))).toBe(false);
  });

  it("never crosses quotes — another quote's items cannot complete the sum", () => {
    const claimed = buildClaimedKeys([row({})], {
      open: [],
      settled: [
        settledItem({ kind: "balance", amount: 1500 }),
        settledItem({ quoteId: "other", quoteRef: "MMR999", kind: "commitment", amount: 400 }),
      ],
    });
    expect(claimed.has(claimKey(QUOTE, "commitment"))).toBe(false);
    expect(claimed.has(claimKey("other", "commitment"))).toBe(false);
  });
});

describe("a half-recorded pair still claims the half that landed", () => {
  // The balance half can fail AFTER the commitment recorded. The row goes back
  // in the queue so the unexplained portion stays visible — but its money did
  // buy the commitment, and dropping that claim is what lets the customer's
  // next standing order auto-reconcile.
  const halfRecorded = {
    open: [{ quoteId: QUOTE, kind: "balance" as const, amount: 1500 }],
    settled: [settledItem({ kind: "deposit", amount: 100 }), settledItem({ kind: "commitment", amount: 400 })],
  };

  it("an unmatched pair row claims the RECORDED commitment", () => {
    const claimed = buildClaimedKeys(
      [row({ status: "unmatched", matchKind: "commitment" })],
      halfRecorded,
    );
    expect(claimed.has(claimKey(QUOTE, "commitment"))).toBe(true);
    // The balance was never recorded, so nothing claims it.
    expect(claimed.has(claimKey(QUOTE, "balance"))).toBe(false);
  });

  it("still claims it after the next sync pass rewrites the stamp", () => {
    // The parked row is re-matched every 2 minutes: MMR112's only OPEN item is
    // now the balance, so the row comes back stamped 'balance'. The claim must
    // survive that — it follows what is RECORDED, not what the row wears.
    const claimed = buildClaimedKeys([row({ status: "unmatched", matchKind: "balance" })], halfRecorded);
    expect(claimed.has(claimKey(QUOTE, "commitment"))).toBe(true);
    expect(claimed.has(claimKey(QUOTE, "balance"))).toBe(false);
  });

  it("so the customer's duplicate £400 parks for a human here too", () => {
    const claimed = buildClaimedKeys([row({ status: "unmatched", matchKind: "balance" })], halfRecorded);
    expect(reconcileSettled(duplicateCommitmentTx, halfRecorded.settled, claimed)).toMatchObject({
      type: "duplicate",
      kind: "commitment",
    });
  });

  it("an ordinary mismatch row still claims nothing", () => {
    // Right quote, wrong amount, nothing recorded off it — the queue is full of
    // these and a claim would flag a legitimate later reconcile as a duplicate.
    const claimed = buildClaimedKeys(
      [row({ status: "unmatched", matchKind: "commitment", amount: 250 })],
      halfRecorded,
    );
    expect(claimed.size).toBe(0);
  });
});

describe("coveringPairPartner — the shape no other path can wear", () => {
  const items = [
    { quoteId: QUOTE, kind: "commitment" as const, amount: 400 },
    { quoteId: QUOTE, kind: "balance" as const, amount: 1500 },
  ];

  it("refuses anything that is not the pair sum to the penny", () => {
    expect(coveringPairPartner({ quoteId: QUOTE, kind: "balance", amount: 1899.99 }, items)).toBeNull();
    expect(coveringPairPartner({ quoteId: QUOTE, kind: "balance", amount: 1900.01 }, items)).toBeNull();
  });

  it("sums in pennies, so figures that misbehave in floating point still pair", () => {
    // 2806.13 = 100.01 + 2706.12; adding those as floats drifts by a fraction.
    expect(
      coveringPairPartner({ quoteId: QUOTE, kind: "balance", amount: 2806.13 }, [
        { quoteId: QUOTE, kind: "commitment", amount: 100.01 },
        { quoteId: QUOTE, kind: "balance", amount: 2706.12 },
      ]),
    ).toBe("commitment");
  });

  it("a zero half is a disguised single item and never pairs", () => {
    expect(
      coveringPairPartner({ quoteId: QUOTE, kind: "balance", amount: 1500 }, [
        { quoteId: QUOTE, kind: "commitment", amount: 0 },
        { quoteId: QUOTE, kind: "balance", amount: 1500 },
      ]),
    ).toBeNull();
  });

  it("a deposit or storage stamp is never half of a pair", () => {
    expect(coveringPairPartner({ quoteId: QUOTE, kind: "deposit", amount: 1900 }, items)).toBeNull();
    expect(coveringPairPartner({ quoteId: QUOTE, kind: "storage", amount: 1900 }, items)).toBeNull();
    expect(coveringPairPartner({ quoteId: QUOTE, kind: null, amount: 1900 }, items)).toBeNull();
  });
});

describe("a whole-job 'full' link claims every payment on the quote", () => {
  it("expands 'full', exactly as healMissingPaidMethods and the ledger do", () => {
    const claimed = buildClaimedKeys([row({ matchKind: "full", amount: 2000 })], {
      open: [],
      settled: SETTLED_AFTER_PAIR,
    });
    expect(claimed.has(claimKey(QUOTE, "deposit"))).toBe(true);
    expect(claimed.has(claimKey(QUOTE, "commitment"))).toBe(true);
    expect(claimed.has(claimKey(QUOTE, "balance"))).toBe(true);
  });

  it("so a second transfer for a whole-job-linked deposit is a duplicate", () => {
    const claimed = buildClaimedKeys([row({ matchKind: "full", amount: 2000 })], {
      open: [],
      settled: SETTLED_AFTER_PAIR,
    });
    expect(
      reconcileSettled(
        { amount: 100, reference: "MMR112", description: null, counterparty: "G JAMES" },
        SETTLED_AFTER_PAIR,
        claimed,
      ),
    ).toMatchObject({ type: "duplicate", kind: "deposit" });
  });
});
