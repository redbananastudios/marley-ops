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

/** The ledger fields the pair derivation needs; `OpenItem`/`SettledItem` fit. */
export interface LedgerLike {
  quoteId: string;
  kind: SettledKind;
  amount: number;
}

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

/**
 * The OPEN-side sibling of `wholeQuoteLinks`, for the settle-in-full transfer.
 *
 * Gate 9c ("settle in full" at the commitment step) tells the customer to send
 * ONE transfer covering commitment + balance — e.g. £1,900 = £400 + £1,500 —
 * under the quote ref. No existing path can explain that transfer:
 * `wholeQuoteLinks` works on SETTLED items and needs the sum of ALL recorded
 * payments (settle-in-full always has a prior recorded deposit, so that sum is
 * deposit + commitment + balance — never what the customer sent), and the
 * per-item matcher/attach are strictly single-item exact-amount. The money
 * landed as a permanent mismatch row while the customer kept being chased for
 * the commitment they had paid.
 *
 * This offers exactly one extra shape — the open commitment + open balance
 * PAIR on one quote, when the transfer equals their sum **to the penny**. It is
 * deliberately NOT a general "any subset of open items" search: the pair is the
 * only sum the product ever asks a customer to send in one transfer, subsets
 * would multiply coincidental sums, and two candidate subsets on a quote would
 * have to yield nothing anyway (ambiguity never guesses). Display-layer only,
 * like `suggestSettledLink`: the office confirms with a tap and BOTH payments
 * are recorded through the normal paid pipelines — nothing is ever automatic.
 */
export interface OpenLike {
  quoteId: string;
  quoteRef: string;
  customer: string | null;
  kind: SettledKind;
  amount: number;
}

export interface CoveringPairLink {
  quoteId: string;
  quoteRef: string;
  customer: string | null;
  /** Always the settle-in-full pair, in ledger order. */
  kinds: ["commitment", "balance"];
  commitmentAmount: number;
  balanceAmount: number;
  /** The summed amount — equals the transfer exactly. */
  amount: number;
}

/**
 * Quotes whose open commitment + open balance, summed, come to exactly
 * `txPennies`. A quote with anything other than exactly ONE open commitment and
 * exactly ONE open balance yields nothing (two candidate pairs is ambiguity;
 * a lone item is the per-item path's territory), and a zero-amount half is a
 * disguised single item, so it never forms a pair either. Two QUOTES that both
 * sum are both returned — a human picks between labelled options; the
 * mismatch-row hint filters to the quote the transfer itself names.
 */
export function coveringPairLinks(
  open: readonly OpenLike[],
  txPennies: number,
): CoveringPairLink[] {
  if (!Number.isFinite(txPennies) || txPennies <= 0) return [];

  const byQuote = new Map<string, OpenLike[]>();
  for (const o of open) {
    const list = byQuote.get(o.quoteId);
    if (list) list.push(o);
    else byQuote.set(o.quoteId, [o]);
  }

  const out: CoveringPairLink[] = [];
  for (const items of byQuote.values()) {
    const commitments = items.filter((i) => i.kind === "commitment");
    const balances = items.filter((i) => i.kind === "balance");
    if (commitments.length !== 1 || balances.length !== 1) continue;
    const commitment = commitments[0];
    const balance = balances[0];
    const comPennies = pennies(commitment.amount);
    const balPennies = pennies(balance.amount);
    if (comPennies <= 0 || balPennies <= 0) continue;
    // Pennies, never pounds — same floating-point rule as wholeQuoteLinks.
    if (comPennies + balPennies !== txPennies) continue;
    out.push({
      quoteId: commitment.quoteId,
      quoteRef: commitment.quoteRef,
      customer: commitment.customer,
      kinds: ["commitment", "balance"],
      commitmentAmount: commitment.amount,
      balanceAmount: balance.amount,
      amount: (comPennies + balPennies) / 100,
    });
  }
  return out.sort((a, b) => a.quoteRef.localeCompare(b.quoteRef));
}

/**
 * The OTHER payment a covering-pair bank row also paid.
 *
 * `recordCoveringPairAction` records TWO payments, but a bank row carries ONE
 * `match_kind` — the 0103 CHECK set has no value for a pair and inventing one
 * is a migration — so the row's stamp is always an under-claim, and the
 * unstamped half is recorded money no bank row claims. That gap is not
 * cosmetic: the sync's `claimed` set is the only thing stopping
 * `reconcileSettled` filing a LATER transfer for the same payment as
 * "explained" (MMR112's £1,900 settle-in-full, then the standing £400
 * commitment the customer forgot to cancel), and that outcome is AUTOMATIC —
 * nobody is watching it.
 *
 * The shape is recoverable from the ledger, so it is re-derived rather than
 * stored: a row stamped with one half of a quote's commitment/balance pair,
 * whose amount equals that pair to the penny, paid BOTH. Nothing else can wear
 * that shape — confirm, attach and link all bind a row's amount to a SINGLE
 * item's amount exactly, and a pair sum equals one half only when the other is
 * zero, which never forms a pair.
 *
 * Ambiguity yields nothing, exactly as `coveringPairLinks` does: anything other
 * than one commitment and one balance on the quote returns null. Items may be
 * settled OR open — the balance half of a pair confirm can fail after the
 * commitment recorded, and that row must still claim what it bought.
 */
export function coveringPairPartner(
  row: { quoteId: string; kind: string | null; amount: number },
  items: readonly LedgerLike[],
): SettledKind | null {
  if (row.kind !== "commitment" && row.kind !== "balance") return null;
  const txPennies = pennies(row.amount);
  if (!Number.isFinite(txPennies) || txPennies <= 0) return null;

  const mine = items.filter((i) => i.quoteId === row.quoteId);
  const commitments = mine.filter((i) => i.kind === "commitment");
  const balances = mine.filter((i) => i.kind === "balance");
  if (commitments.length !== 1 || balances.length !== 1) return null;
  const comPennies = pennies(commitments[0].amount);
  const balPennies = pennies(balances[0].amount);
  if (comPennies <= 0 || balPennies <= 0) return null;
  // Pennies, never pounds — same floating-point rule as coveringPairLinks.
  if (comPennies + balPennies !== txPennies) return null;
  return row.kind === "commitment" ? "balance" : "commitment";
}
