/**
 * Which of a lead's other quotes stop being live when one is sent.
 *
 * Marley revises a quote by building a NEW one — the reference on the customer's
 * PDF (MMR050 → MMR051) is part of the document, so a revision cannot be an
 * in-place edit of something already in their inbox. That worked, except nothing
 * retired the old row: superseding only ran on ACCEPT. So on 2026-08-10 Luke sent
 * MMR050 (£1,782), the customer replied that the destination postcode was wrong,
 * and the corrected MMR051 (£1,738.80) went out — leaving BOTH sitting in
 * "Awaiting reply", both counted in open pipeline, both on the chase ladder, with
 * the customer holding two different prices for the same move.
 *
 * Superseding at SEND time makes "build a new one" the safe, obvious way to
 * revise, which is what people already do.
 */

export interface SiblingQuote {
  id: string;
  quote_ref: string | null;
  status: string | null;
  deposit_paid_at?: string | null;
  zoho_deposit_invoice_id?: string | null;
  zoho_balance_invoice_id?: string | null;
  zoho_commitment_invoice_id?: string | null;
}

export interface SupersedePlan {
  /** Safe to retire — sent, nothing financial attached. */
  supersede: SiblingQuote[];
  /** Left alone because money is attached; the office is told. */
  blocked: SiblingQuote[];
}

/** "pending" is the placeholder written before Zoho answers — not a real invoice. */
const realZoho = (v: string | null | undefined): boolean => !!v && v !== "pending";

const carriesMoney = (q: SiblingQuote): boolean =>
  !!q.deposit_paid_at ||
  realZoho(q.zoho_deposit_invoice_id) ||
  realZoho(q.zoho_balance_invoice_id) ||
  realZoho(q.zoho_commitment_invoice_id);

/**
 * `keepId` is the quote just sent. Only OTHER 'sent' quotes are touched:
 *  - accepted → has a live booking and invoices behind it; unwinding those is
 *    rejectQuote's job, and doing it silently on a send would cancel a customer's
 *    move because someone re-quoted them.
 *  - draft → unfinished internal work, never seen by anyone. Nothing to retire.
 */
export function planSupersede(siblings: readonly SiblingQuote[], keepId: string): SupersedePlan {
  const plan: SupersedePlan = { supersede: [], blocked: [] };
  for (const q of siblings) {
    if (q.id === keepId || q.status !== "sent") continue;
    (carriesMoney(q) ? plan.blocked : plan.supersede).push(q);
  }
  return plan;
}

/** "MMR050" / "MMR050 and MMR051" / "MMR050, MMR051 and MMR052" — for office copy. */
export function refList(quotes: readonly SiblingQuote[]): string {
  const refs = quotes.map((q) => q.quote_ref ?? "an earlier quote");
  if (refs.length <= 1) return refs[0] ?? "";
  return `${refs.slice(0, -1).join(", ")} and ${refs[refs.length - 1]}`;
}
