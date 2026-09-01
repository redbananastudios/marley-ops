/**
 * Brand resolution for CUSTOMER COPY — SERVER ONLY.
 *
 * `getBrandOrDefault` returns the brand row as STORED. That is the right answer
 * for Settings, where an admin must see the value they typed, and the wrong one
 * for an email: card copy is gated on TWO switches ANDed (PRD §11.10), the
 * global `business_settings.card_payments_enabled` kill switch and the brand's
 * own column, and a Brand row carries only the second.
 *
 * Every email builder already keys its card wording off `brand.cardPaymentsEnabled`
 * (`emailTheme`), as does the invoice note (`invoicePayClause`). So the fix is
 * to hand those builders a Brand carrying the EFFECTIVE flag instead of the
 * stored one, ONCE at resolution, rather than threading a second boolean
 * through ~15 call sites. Neither function changes.
 *
 * The hole this closes: global switch OFF plus a non-default brand whose own
 * column is ON produced "pay by card over the phone" in email while `/q`
 * rendered no card button at all — the customer is invited to use a rail that
 * does not exist. The escape hatch that was supposed to carry the global
 * switch (`EmailThemeOptions.cardPhone`) had ZERO assigning callers repo-wide,
 * so it never carried anything.
 *
 * Deliberately NOT solved by another optional flag: the previous fix replaced
 * "an opts flag no caller sets" with "brand flag ?? an opts flag no caller
 * sets", which recreated the same dead control one level up. A resolver a
 * caller must go through cannot be silently left unwired — and
 * `tests/lib/comms/card-toggle.test.ts` asserts the copy sites go through it.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_BRAND, getBrandOrDefault, type Brand } from "@/lib/brand";
import { cardPaymentsAvailable } from "@/lib/payments/card-availability";

/**
 * The brand to word a customer email or invoice note with: the stored row,
 * except that `cardPaymentsEnabled` is replaced by whether the card channel is
 * actually LIVE for it right now.
 *
 * Fails CLOSED — an unreadable settings row or brands row yields `false`, so a
 * failure drops the card mention rather than advertising a rail that may be
 * switched off. Same bias as `cardPaymentsAvailable` itself.
 *
 * The default brand is unaffected in practice: `emailTheme` returns its LITERAL
 * theme and `invoicePayClause` short-circuits on the slug, both by design
 * (the byte-lock in `tests/lib/comms/email-brand.test.ts`), so its copy cannot
 * change here. That remains the open remainder of QA-20260826-07 and is
 * deliberately not resolved by this function.
 */
export async function brandForComms(sb: SupabaseClient, slug: string | null): Promise<Brand> {
  const brand = await getBrandOrDefault(sb, slug ?? DEFAULT_BRAND);
  const live = await cardPaymentsAvailable(sb, brand.slug).catch(() => false);
  // Return the SAME object when nothing differs, so a caller that compares
  // identities (or a test asserting "marley is untouched") sees no churn.
  return live === brand.cardPaymentsEnabled ? brand : { ...brand, cardPaymentsEnabled: live };
}
