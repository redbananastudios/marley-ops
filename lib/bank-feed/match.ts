/**
 * Bank-transaction → open-invoice matcher (pure, no I/O). Conservative by
 * design: a match only ever becomes a SUGGESTION the office confirms — money
 * is never auto-marked. Two confidence tiers:
 *
 *   reference — the customer's payment reference contains a quote ref
 *               (MMR001 / MMC001, the legacy MM-YYMMDD-NNN, or a Zoho
 *               -DEP/-BAL reference which embeds the quote ref anyway)
 *   amount    — no usable reference, but EXACTLY ONE open item wants exactly
 *               this amount (ambiguity = no match; people mangle references,
 *               but two £100 deposits outstanding means a human must look)
 *
 * Storage references (MMS-<let8>-<period>) are recognised and tagged but not
 * actionable here — storage payments are recorded from the Storage page.
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

export interface MatchResult {
  kind: "deposit" | "balance" | "storage";
  confidence: "reference" | "amount";
  quoteId: string | null;
  quoteRef: string | null;
}

/** Quote refs recognisable inside free-text bank references. */
const REF_PATTERNS = [
  /MM[RC]\d{3,}/gi, // MMR001 / MMC014 (current scheme)
  /MM-\d{6}-\d{3}/gi, // legacy MM-YYMMDD-NNN
];
const STORAGE_REF = /MMS-[A-Za-z0-9]{6,}/i;

const norm = (s: string | null | undefined): string => (s ?? "").toUpperCase();

/** All quote refs mentioned in the transaction's reference/description text. */
export function refsInText(reference: string | null, description: string | null): string[] {
  const hay = `${norm(reference)} ${norm(description)}`;
  const found = new Set<string>();
  for (const re of REF_PATTERNS) {
    re.lastIndex = 0;
    for (const m of hay.matchAll(re)) found.add(m[0].toUpperCase());
  }
  return [...found];
}

const pennies = (n: number): number => Math.round(n * 100);

export function matchTransaction(
  tx: { amount: number; reference: string | null; description: string | null },
  open: OpenItem[],
): MatchResult | null {
  const hay = `${norm(tx.reference)} ${norm(tx.description)}`;

  if (STORAGE_REF.test(hay)) {
    return { kind: "storage", confidence: "reference", quoteId: null, quoteRef: null };
  }

  const refs = refsInText(tx.reference, tx.description);
  if (refs.length) {
    // Zoho invoice references are `<quoteRef>-DEP` / `<quoteRef>-BAL`, so the
    // suffix (when the customer copied it faithfully) disambiguates the kind.
    const wantsDep = hay.includes("-DEP");
    const wantsBal = hay.includes("-BAL");
    const candidates = open.filter((o) => refs.includes(o.quoteRef.toUpperCase()));
    if (candidates.length) {
      const pick =
        candidates.find((o) => (wantsDep && o.kind === "deposit") || (wantsBal && o.kind === "balance")) ??
        // Exact amount beats kind guessing; else prefer the deposit (it's
        // what's requested first in the flow).
        candidates.find((o) => pennies(o.amount) === pennies(tx.amount)) ??
        candidates.find((o) => o.kind === "deposit") ??
        candidates[0];
      return { kind: pick.kind, confidence: "reference", quoteId: pick.quoteId, quoteRef: pick.quoteRef };
    }
    return null; // names a quote we don't have open — human territory
  }

  // No reference → amount-only, and only when it's unambiguous.
  const byAmount = open.filter((o) => pennies(o.amount) === pennies(tx.amount));
  if (byAmount.length === 1) {
    const o = byAmount[0];
    return { kind: o.kind, confidence: "amount", quoteId: o.quoteId, quoteRef: o.quoteRef };
  }
  return null;
}
