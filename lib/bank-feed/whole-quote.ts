/**
 * One transfer that pays a whole job.
 *
 * The ledger splits a job into separate payable items (deposit, commitment,
 * balance) and the manual link path matches ONE of them at an exact amount. That
 * is right for a customer who pays a deposit now and a balance later — but a
 * customer who settles the job in a single transfer matches no individual item,
 * so their money sits in "Transfers that need a human" with nothing the office
 * can pick, forever. Live example: IMV012 was imported already paid with a
 * blanket £100 deposit, so its settled items are £100 + £560 and the real £660
 * transfer that paid it could be linked to neither.
 *
 * This offers exactly one extra choice — "the whole quote" — and only when the
 * transfer equals the sum **to the penny**. No deltas, no fuzzy matching: the
 * amount rule that makes linking safe is preserved, it is just applied to the
 * set rather than to each item.
 */

export type SettledKind = "deposit" | "commitment" | "balance";

export interface SettledLike {
  quoteId: string;
  quoteRef: string;
  customer: string | null;
  kind: SettledKind;
  amount: number;
}

export interface WholeQuoteLink {
  quoteId: string;
  quoteRef: string;
  customer: string | null;
  /** Every recorded payment this transfer explains, in ledger order. */
  kinds: SettledKind[];
  /** The summed amount — equals the transfer exactly. */
  amount: number;
}

const pennies = (n: number): number => Math.round(n * 100);

/** Ledger order, so "deposit + balance" never reads as "balance + deposit". */
const ORDER: Record<SettledKind, number> = { deposit: 0, commitment: 1, balance: 2 };

/**
 * Quotes whose recorded payments, summed, come to exactly `txPennies`.
 *
 * Deliberately skips quotes with a single settled item: that case is already
 * offered by the per-item path, and a second identical-looking row would just
 * make the office choose between two things that do the same thing.
 */
export function wholeQuoteLinks(
  settled: readonly SettledLike[],
  txPennies: number,
): WholeQuoteLink[] {
  if (!Number.isFinite(txPennies) || txPennies <= 0) return [];

  const byQuote = new Map<string, SettledLike[]>();
  for (const s of settled) {
    const list = byQuote.get(s.quoteId);
    if (list) list.push(s);
    else byQuote.set(s.quoteId, [s]);
  }

  const out: WholeQuoteLink[] = [];
  for (const items of byQuote.values()) {
    if (items.length < 2) continue;
    // Sum in pennies, never in pounds: 2806.13-style figures do not add up
    // cleanly in binary floating point and a 1p drift would silently refuse a
    // legitimate link.
    const total = items.reduce((sum, i) => sum + pennies(i.amount), 0);
    if (total !== txPennies) continue;
    const ordered = [...items].sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
    out.push({
      quoteId: ordered[0].quoteId,
      quoteRef: ordered[0].quoteRef,
      customer: ordered[0].customer,
      kinds: ordered.map((i) => i.kind),
      amount: total / 100,
    });
  }
  return out.sort((a, b) => a.quoteRef.localeCompare(b.quoteRef));
}

/** "deposit + balance" — what the office reads on the row it is picking. */
export function describeKinds(kinds: readonly SettledKind[]): string {
  return kinds.join(" + ");
}
