/**
 * Quote-reference helpers. The reference is a short, human-typable string the
 * customer quotes as their bank-transfer reference: MMR### (residential) or
 * MMC### (commercial), PMR###/PMC### for Pitmans. The counter is minted by
 * brand_ref_counters via the next_quote_ref() RPC (migrations 0037, 0104);
 * this module only decides the KIND.
 */

import { type PaymentPolicy } from "@/lib/payments-policy";

/**
 * Does a lead's property size READ as commercial? "Office / commercial" is a
 * real option on the website form and is the only value that has ever matched
 * in production (2 of 99 quotes, 2026-08-28).
 *
 * This is a HINT, never a classification. It is a dropdown value a customer
 * picked about their building, not a decision anyone made about how they pay,
 * so it must not be allowed to put a client onto post-pay terms or switch off
 * their chase by itself. Gate 10 surfaces it to the office as a suggestion they
 * tap; nothing acts on it automatically.
 */
export function looksCommercial(propertySize: string | null | undefined): boolean {
  return /office|commercial/i.test(propertySize ?? "");
}

/**
 * Residential vs commercial quote-ref kind (multi-brand PRD §3.10, gate 8).
 *
 * The PRD replaces the old property-size regex with the client's type, and the
 * client's type is authoritative here — but ONLY in the direction that adds
 * information. When no client is flagged commercial we still fall back to the
 * property-size hint, which is why this gate changes no live reference.
 *
 * The asymmetry is the point, and it is the same split the rest of gate 8
 * follows. The ref kind is a cosmetic attribution letter, fixed for good the
 * moment it is issued and matched by the bank feed either way
 * (`(MM|PM)[RC]\d{3,}` — lib/bank-feed/match.ts), so a weaker signal is
 * perfectly safe here. The PAYMENT POLICY is not: it decides whether we take a
 * deposit or extend credit, so resolvePaymentPolicy() reads the explicit flag
 * and nothing else. Same input, two different evidence bars, because one of
 * them is read by a human and the other one acts.
 *
 * Dropping the fallback would have quietly cost the two live "Office /
 * commercial" enquiries their C prefix, since no production client carries
 * is_company today — a regression bought for nothing.
 */
export function quoteRefKind(
  policy: PaymentPolicy,
  propertySize: string | null | undefined,
): "R" | "C" {
  if (policy === "commercial") return "C";
  return looksCommercial(propertySize) ? "C" : "R";
}
