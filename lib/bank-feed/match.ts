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
 *
 * A second, later layer handles the payment that was recorded BEFORE its bank
 * row was processed (Connor records it in Zoho → the poll marks it paid, or an
 * office one-tap): the open set no longer contains it, so the transfer could
 * never match and sat in "Unmatched inbound" forever (Brydee Thomas MMR034's
 * £450 "MMR034-BAL", 2026-08-16). reconcileSettled/matchTransactionLedger tie
 * such a transfer to its already-recorded item — reference + exact amount
 * only, and the paid pipeline is never run off it.
 */

export interface OpenItem {
  quoteId: string;
  quoteRef: string;
  leadId: string | null;
  customer: string | null;
  /** deposit → deposit_amount; commitment → commitment_invoice_amount;
   *  balance → the balance actually invoiced/due. */
  amount: number;
  kind: "deposit" | "commitment" | "balance";
}

export type MatchResult =
  | {
      type: "suggestion";
      kind: "deposit" | "commitment" | "balance";
      confidence: "reference" | "amount";
      quoteId: string;
      quoteRef: string;
      /** The open item's amount — MUST equal the transfer amount (invariant). */
      amount: number;
    }
  | { type: "mismatch"; kind: "deposit" | "commitment" | "balance"; quoteId: string; quoteRef: string }
  | { type: "storage" };

/** A deposit/commitment/balance that is already PAID on the books — the
 *  reconcile pool. Includes cancelled bookings (their recorded money is still
 *  real money that arrived by bank). */
export interface SettledItem {
  quoteId: string;
  quoteRef: string;
  leadId: string | null;
  customer: string | null;
  amount: number;
  kind: "deposit" | "commitment" | "balance";
}

export interface ReconciledMatch {
  type: "reconciled";
  kind: "deposit" | "commitment" | "balance";
  quoteId: string;
  quoteRef: string;
}

export type LedgerMatchResult = MatchResult | ReconciledMatch;

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

/**
 * Words that carry no identity: they appear in company suffixes and in the
 * free text of a bank reference, so treating them as a name overlap would
 * corroborate a stranger ("PAYMENT TO ACME LTD" vs a customer "MY SAFETY LTD").
 * Corroboration is meant to prove WHO paid, so a token that could belong to
 * anyone proves nothing.
 */
const GENERIC_NAME_TOKENS = new Set([
  "LTD", "LIMITED", "PLC", "LLP", "THE", "AND", "FOR", "REF", "REFERENCE",
  "PAYMENT", "PAYMENTS", "PAID", "INVOICE", "TRANSFER", "BANK", "ACCOUNT",
  "DEPOSIT", "BALANCE", "COMMITMENT", "MOVE", "MOVES", "MOVING", "REMOVAL",
  "REMOVALS", "MARLEY", "THANKS", "THANK",
]);

/** Identity-bearing name tokens ≥3 chars, uppercased — "E Dingley" → ["DINGLEY"]. */
function nameTokens(name: string | null | undefined): string[] {
  return norm(name)
    .split(/[^A-Z]+/)
    .filter((t) => t.length >= 3 && !GENERIC_NAME_TOKENS.has(t));
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

    // A suggestion requires the EXACT amount. The Zoho -DEP/-COM/-BAL suffix
    // picks between same-amount open items on one quote (rare but real).
    const exact = candidates.filter((o) => pennies(o.amount) === pennies(tx.amount));
    if (exact.length) {
      const wantsDep = hay.includes("-DEP");
      const wantsCom = hay.includes("-COM");
      const wantsBal = hay.includes("-BAL");
      const pick =
        exact.find(
          (o) =>
            (wantsDep && o.kind === "deposit") ||
            (wantsCom && o.kind === "commitment") ||
            (wantsBal && o.kind === "balance"),
        ) ?? exact[0];
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

  // No reference → amount-only. Confirmable ONLY when the payer name
  // corroborates exactly ONE of the open items at this amount. Corroboration
  // comes FIRST: with commitment invoices in the pool, same-amount collisions
  // across unrelated quotes are routine (£100 deposit vs a £100 commitment on
  // an £800 job) and must not blind a match the name resolves. Amount alone is
  // still never enough — a coincidental £100 from an unrelated payer stays
  // unmatched for a human — and two corroborating candidates stay ambiguous.
  const byAmount = open.filter((o) => pennies(o.amount) === pennies(tx.amount));
  const corroborated = byAmount.filter((o) => namesCorroborate(tx.counterparty, o.customer));
  if (corroborated.length === 1) {
    const o = corroborated[0];
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

/** The Zoho invoice-reference suffix, when the transfer carries one —
 *  "MMR034-BAL" is the customer paying the exact invoice we raised. */
function suffixKind(hay: string): "deposit" | "commitment" | "balance" | null {
  if (hay.includes("-DEP")) return "deposit";
  if (hay.includes("-COM")) return "commitment";
  if (hay.includes("-BAL")) return "balance";
  return null;
}

/**
 * Reconcile a transfer against ALREADY-RECORDED payments: quote ref in the
 * text + the exact amount of a settled item. Deliberately stricter than the
 * open matcher — no amount-only path, no name corroboration — because the
 * outcome is automatic (no human tap): a wrong reconcile silently hides money,
 * so only the unambiguous shape qualifies.
 */
export function reconcileSettled(
  tx: { amount: number; reference: string | null; description: string | null; counterparty?: string | null },
  settled: SettledItem[],
): ReconciledMatch | null {
  const refs = refsInText(tx.reference, tx.description);
  if (!refs.length) return null;
  const candidates = settled.filter(
    (s) => refs.includes(s.quoteRef.toUpperCase()) && pennies(s.amount) === pennies(tx.amount),
  );
  if (!candidates.length) return null;
  const hay = canonicalizeQuoteRefs(`${norm(tx.reference)} ${norm(tx.description)}`);
  const wants = suffixKind(hay);
  const pick = (wants && candidates.find((s) => s.kind === wants)) || candidates[0];
  return { type: "reconciled", kind: pick.kind, quoteId: pick.quoteId, quoteRef: pick.quoteRef };
}

/**
 * The DISPLAY-layer sibling of reconcileSettled, for the transfer that carries
 * no quote ref at all — "DINGLEY" £1,100 while Emma Dingley's £1,100 balance is
 * already on the books. Auto-reconcile deliberately refuses these (reference +
 * exact amount only, because its outcome is automatic); but leaving the row
 * saying "no matching open payment — attach it" when the system can SEE the
 * recorded twin is the queue lying to the office. So: exact pennies + the payer
 * name (or reference text) corroborating exactly ONE settled item produces a
 * HINT the UI renders as a one-tap "Link" — a human confirms, nothing is
 * automatic, and ambiguity (two candidates, or none by name) yields nothing.
 */
export function suggestSettledLink(
  tx: { amount: number; reference: string | null; description: string | null; counterparty?: string | null },
  settled: SettledItem[],
): SettledItem | null {
  // A transfer that NAMES a quote is the auto path's territory — if it didn't
  // reconcile there, the amounts genuinely differ and a hint would be wrong.
  if (refsInText(tx.reference, tx.description).length) return null;
  const exact = settled.filter((s) => pennies(s.amount) === pennies(tx.amount));
  if (!exact.length) return null;
  // Names can arrive in the counterparty OR the free-text reference ("E Dingley"
  // / "DINGLEY") — corroborate against the whole haystack. Generic reference
  // words can't collide: the overlap is with the CUSTOMER's name tokens.
  const hay = `${tx.counterparty ?? ""} ${tx.reference ?? ""} ${tx.description ?? ""}`;
  const corroborated = exact.filter((s) => namesCorroborate(hay, s.customer));
  return corroborated.length === 1 ? corroborated[0] : null;
}

/**
 * The full decision: open items first (real money wanting recording, human-
 * confirmed), settled reconcile as the fallback for unmatched/mismatch shapes.
 * One deliberate exception: when the transfer's OWN suffix names the settled
 * kind ("MMR034-BAL" after the balance was recorded via Zoho) and the open
 * suggestion is for a DIFFERENT kind that merely shares the amount, the
 * transfer IS the already-recorded payment — reconciling wins, because the
 * suggestion would invite the office to one-tap-record the same money twice.
 */
export function matchTransactionLedger(
  tx: { amount: number; reference: string | null; description: string | null; counterparty?: string | null },
  open: OpenItem[],
  settled: SettledItem[],
): LedgerMatchResult | null {
  const m = matchTransaction(tx, open);
  if (m && m.type === "storage") return m;
  const s = reconcileSettled(tx, settled);
  if (!s) return m;
  if (!m || m.type === "mismatch") return s;
  const hay = canonicalizeQuoteRefs(`${norm(tx.reference)} ${norm(tx.description)}`);
  const wants = suffixKind(hay);
  if (wants && s.kind === wants && m.kind !== wants) return s;
  return m;
}
