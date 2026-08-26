/**
 * Which platform we ask a customer to review us on — pure logic, no IO, so the
 * routing is unit-testable without a database.
 *
 * A Google review requires a Google account, so only customers writing from a
 * Google mailbox get the Google link; everyone else is asked on Trustpilot,
 * which has no account barrier (Peter, 2026-08-19). A lead that came via
 * Checkatrade is asked on Checkatrade regardless of mailbox — that review
 * feeds the profile the customer actually found us on.
 */

/** Canonical "write a review" links per platform. The Google entry is the GBP
 *  short link for the current listing — NOT the old
 *  search.google.com/local/writereview?placeid=… form, which pointed at the
 *  wrong listing (fixed 2026-08-19, migration 0100). Settings can override the
 *  Google URL; the others are fixed here. */
export const REVIEW_LINKS = {
  google: { platform: "Google", url: "https://g.page/r/CXD_Yh4RUF1cEBM/review" },
  checkatrade: { platform: "Checkatrade", url: "https://www.checkatrade.com/give-feedback/trades/marleymoves" },
  trustpilot: { platform: "Trustpilot", url: "https://uk.trustpilot.com/evaluate/marleymoves.co.uk" },
} as const;

/** gmail.com plus the legacy googlemail.com form (still live for older UK accounts). */
const GOOGLE_MAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

export function hasGoogleMailbox(email: string): boolean {
  const domain = email.trim().toLowerCase().split("@").pop() ?? "";
  return GOOGLE_MAIL_DOMAINS.has(domain);
}

/** Pick the review ask for one customer. `googleUrl` is the Settings value
 *  (already defaulted by the caller) so an office override still applies. */
export function selectReviewLink(
  email: string,
  entryChannel: string | null,
  googleUrl: string,
): { platform: string; url: string } {
  if (entryChannel === "checkatrade") return REVIEW_LINKS.checkatrade;
  if (hasGoogleMailbox(email)) return { platform: REVIEW_LINKS.google.platform, url: googleUrl };
  return REVIEW_LINKS.trustpilot;
}

/**
 * Multi-brand routing (docs/multi-brand-prd.md §3.5). Every link above is a
 * MARLEY property — the Checkatrade and Trustpilot profiles and the Settings
 * Google URL all point at Marley's listings — so a non-default brand may only
 * ever be asked on its own brands.review_url. Null there means NO review ask
 * for that brand at all (the caller must skip and log, never fall back to
 * business_settings.google_review_url). Marley keeps the mailbox/channel
 * routing unchanged.
 */
export function selectBrandReviewLink(
  brand: { slug: string; reviewUrl: string | null },
  defaultBrandSlug: string,
  email: string,
  entryChannel: string | null,
  marleyGoogleUrl: string,
): { platform: string; url: string } | null {
  if (brand.slug === defaultBrandSlug) return selectReviewLink(email, entryChannel, marleyGoogleUrl);
  const url = (brand.reviewUrl ?? "").trim();
  return url ? { platform: "Google", url } : null;
}
