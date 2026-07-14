/**
 * Quote-reference helpers. The reference is a short, human-typable string the
 * customer quotes as their bank-transfer reference: MMR### (residential) or
 * MMC### (commercial). The counter is minted by the DB sequence via the
 * next_quote_ref() RPC (migration 0037); this module only decides the KIND.
 */

/**
 * Residential vs commercial quote-ref kind, derived from the lead's property
 * size. "Office / commercial" (or anything that reads office/commercial) → "C";
 * everything else — and any missing/blank size — → "R" (the common case).
 */
export function quoteRefKind(propertySize: string | null | undefined): "R" | "C" {
  return /office|commercial/i.test(propertySize ?? "") ? "C" : "R";
}
