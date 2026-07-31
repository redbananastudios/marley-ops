/**
 * Bank-transaction → open-invoice matcher (pure, no I/O). Conservative by
 * design: a match only ever becomes a SUGGESTION the office confirms — and a
 * suggestion REQUIRES the transfer amount to equal the open item's amount to
 * the penny. Partial payments, overpayments and duplicate transfers must be
 * handled by a human via Bookings/Zoho, never one-tap recorded (review
 * 2026-07-16: the paid pipeline records the ITEM's amount, so confirming a
 * £500 transfer against a £1,100 balance would book £1,100 into the VAT
 * records off £500 received).
 *
 * Result kinds:
 *   suggestion — a quote ref (typo-tolerant: O/0, I/1 … normalised) with the
 *                exact amount, OR a UNIQUE exact amount whose payer NAME also
 *                corroborates the customer. Confirmable. Amount alone is never
 *                enough — a coincidental amount from an unrelated payer is not a
 *                suggestion (2026-07-31: a stranger's £100 must not one-tap-match
 *                someone else's quote).
 *   mismatch   — the reference names an open quote but NO open item has this
 *                exact amount (part-payment / overpayment / duplicate):
 *                surfaced on /payments as "record manually", never confirmable.
 *   storage    — MMS-… reference: recorded from the Storage page.
 *   null       — nothing recognisable.
 */

export interface OpenItem {
  quoteId: string;
  quoteRef: string;
  leadId: string | null;
  customer: string | null;
  /** deposit → deposit_amount; balance → the balance actually invoiced/due. */
  amount: number;
  kind: "deposit" | "balance";
}

export type MatchResult =
  | {
      type: "suggestion";
      kind: "deposit" | "balance";
      confidence: "reference" | "amount";
      quoteId: string;
      quoteRef: string;
      /** The open item's amount — MUST equal the transfer amount (invariant). */
      amount: number;
    }
  | { type: "mismatch"; kind: "deposit" | "balance"; quoteId: string; quoteRef: string }
  | { type: "storage" };

/** Quote refs recognisable inside free-text bank references. */
const REF_PATTERNS = [
  /MM[RC]\d{3,}/gi, // MMR001 / MMC014 (current scheme)
  /MM-\d{6}-\d{3}/gi, // legacy MM-YYMMDD-NNN
];
const STORAGE_REF = /MMS-[A-Za-z0-9]{6,}/i;

const norm = (s: string | null | undefined): string => (s ?? "").toUpperCase();

/**
 * Common keying/OCR slips inside a quote ref's numeric tail — a customer types
 * their ref as "MMRO17" (letter O for zero) or "MMRl23". Normalising the
 * lookalikes to digits lets a correctly-referenced payment still match by
 * REFERENCE instead of falling through to the weak amount-only path.
 * (2026-07-31 incident: an "MMRO17" transfer went unmatched while a stranger's
 * £100 amount-matched the very same quote.)
 */
const DIGIT_LOOKALIKE: Record<string, string> = { O: "0", I: "1", L: "1", B: "8", S: "5", Z: "2" };
function canonicalizeQuoteRefs(hay: string): string {
  // Only ever touch an MM[RC] token whose tail is digits-or-lookalikes; storage
  // (MMS-…) and legacy MM-YYMMDD-NNN refs never match this and stay untouched.
  return hay.replace(/\bMM([RC])([0-9OILBSZ]{3,})\b/g, (_m, kind: string, tail: string) =>
    "MM" + kind + tail.replace(/[OILBSZ]/g, (c) => DIGIT_LOOKALIKE[c] ?? c),
  );
}

/** Name tokens ≥3 chars, uppercased — "E Dingley" → ["DINGLEY"]. */
function nameTokens(name: string | null | undefined): string[] {
  return norm(name)
    .split(/[^A-Z]+/)
    .filter((t) => t.length >= 3);
}

/**
 * The payer name plausibly belongs to the customer: they share a ≥3-char token
 * (a surname-ish overlap). A missing name on EITHER side is NOT corroboration —
 * amount-only is a weak signal, so it must fail safe. This is what stops a
 * stranger's transfer being one-tap-confirmable against an unrelated quote just
 * because the pennies happen to line up.
 */
function namesCorroborate(payer: string | null | undefined, customer: string | null | undefined): boolean {
  const payerTokens = nameTokens(payer);
  if (!payerTokens.length) return false;
  const customerTokens = new Set(nameTokens(customer));
  return payerTokens.some((t) => customerTokens.has(t));
}

/** All quote refs mentioned in the transaction's reference/description text. */
export function refsInText(reference: string | null, description: string | null): string[] {
  const hay = canonicalizeQuoteRefs(`${norm(reference)} ${norm(description)}`);
  const found = new Set<string>();
  for (const re of REF_PATTERNS) {
    re.lastIndex = 0;
    for (const m of hay.matchAll(re)) found.add(m[0].toUpperCase());
  }
  return [...found];
}

const pennies = (n: number): number => Math.round(n * 100);

export function matchTransaction(
  tx: { amount: number; reference: string | null; description: string | null; counterparty?: string | null },
  open: OpenItem[],
): MatchResult | null {
  const hay = canonicalizeQuoteRefs(`${norm(tx.reference)} ${norm(tx.description)}`);

  if (STORAGE_REF.test(hay)) return { type: "storage" };

  const refs = refsInText(tx.reference, tx.description);
  if (refs.length) {
    const candidates = open.filter((o) => refs.includes(o.quoteRef.toUpperCase()));
    if (!candidates.length) return null; // names a quote we don't have open — human territory

    // A suggestion requires the EXACT amount. The Zoho -DEP/-BAL suffix picks
    // between a same-amount deposit and balance on one quote (rare but real).
    const exact = candidates.filter((o) => pennies(o.amount) === pennies(tx.amount));
    if (exact.length) {
      const wantsDep = hay.includes("-DEP");
      const wantsBal = hay.includes("-BAL");
      const pick =
        exact.find((o) => (wantsDep && o.kind === "deposit") || (wantsBal && o.kind === "balance")) ?? exact[0];
      return {
        type: "suggestion",
        kind: pick.kind,
        confidence: "reference",
        quoteId: pick.quoteId,
        quoteRef: pick.quoteRef,
        amount: pick.amount,
      };
    }

    // Right quote, wrong amount — part-payment/overpayment/duplicate. Flag it
    // for a human; the paid pipeline must never run off this transfer.
    const c = candidates[0];
    return { type: "mismatch", kind: c.kind, quoteId: c.quoteId, quoteRef: c.quoteRef };
  }

  // No reference → amount-only. Confirmable ONLY when it's unambiguous (exactly
  // one open item of this amount) AND the payer name corroborates that
  // customer. Amount alone is too weak to move money: a coincidental £100 from
  // an unrelated payer must stay unmatched for a human, never a one-tap match.
  const byAmount = open.filter((o) => pennies(o.amount) === pennies(tx.amount));
  if (byAmount.length === 1 && namesCorroborate(tx.counterparty, byAmount[0].customer)) {
    const o = byAmount[0];
    return {
      type: "suggestion",
      kind: o.kind,
      confidence: "amount",
      quoteId: o.quoteId,
      quoteRef: o.quoteRef,
      amount: o.amount,
    };
  }
  return null;
}
