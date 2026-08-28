/**
 * Who a ledger contact represents — the stable, provider-neutral key.
 *
 * ## Why a name is not a key
 *
 * Xero enforces a unique `ContactName` across all active contacts and Zoho does
 * not (design §5). Today every call site resolves a contact by customer NAME, so
 * under Xero the second "John Smith" either fails outright or — far worse —
 * adopts the first one's contact and bills a stranger. Xero's own guidance is to
 * key on `ContactID` and carry your own identifier in `ContactNumber`; this type
 * is what the Xero adapter stamps there. The Zoho adapter drops it.
 *
 * ## Why `party` is REQUIRED rather than optional
 *
 * An optional field lets a call site added next year silently fall through to
 * name-only resolution under Xero — the exact collision this exists to prevent,
 * arriving quietly and on the money path. Required means tsc enumerates every
 * call site at the seam, now and for every future one.
 */
import { log } from "@/lib/log";

export type LedgerParty =
  | { kind: "client"; id: string }
  | { kind: "quote"; id: string };

/**
 * The party for a quote: its client if it has one, otherwise the quote itself.
 *
 * `quotes.client_id` is nullable in DDL, but the only writer in the product
 * (`app/(dashboard)/quotes/actions.ts`) takes it from the lead, and `leads.client_id`
 * is NOT NULL — "every quote belongs to a client→lead, no orphan quotes" (Peter,
 * 2026-07-11). Measured on production 2026-08-28: 0 of 116 quotes have a null
 * `client_id`. So the quote branch is a **guard, not a path**; it is reachable
 * only by hand-written SQL, an import script that skips `attachOrCreateClient`,
 * or a regression.
 *
 * Falling back to the quote id rather than to the customer name is deliberate,
 * and the failure directions are not symmetric:
 *
 *  - **Quote id:** one person with two client-less quotes gets two Xero contacts.
 *    Fragmentation — visible in Xero's contact list, fixable by a human, and it
 *    never mis-bills.
 *  - **Name:** two different people sharing a name collapse into one contact, and
 *    a stranger is billed. Silent, and unrecoverable once the invoice is sent.
 *
 * Ambiguity therefore yields a weaker-but-honest key, never a plausible guess.
 *
 * Throwing was the third option and is rejected: these are money paths that must
 * not become customer-visible failures over a data-shape anomaly.
 * `reverseDepositVatInZoho` is documented as never throwing because the caller's
 * money movement is already committed, and the three invoice-raise paths would
 * release their claim and retry forever against a condition no retry can fix.
 *
 * The fallback logs because a branch that can only fire when something upstream
 * has broken, and fires silently, is precisely the "'I could not check' must
 * never render as 'nothing to report'" shape. Not an ops alert — nothing is
 * on fire and crying wolf costs more than it buys — but a line a sweep can count.
 */
export function partyForQuote(input: { id: string; clientId: string | null }): LedgerParty {
  if (input.clientId) return { kind: "client", id: input.clientId };
  log.warn("ledger.contact.quote_keyed", { quoteId: input.id });
  return { kind: "quote", id: input.id };
}
