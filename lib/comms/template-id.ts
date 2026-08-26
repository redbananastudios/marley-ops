import { DEFAULT_BRAND, type Brand } from "@/lib/brand";

/**
 * Per-brand Resend template resolution (PRD §11.7 trap 4).
 *
 * KEY CONVENTION — `brands.resend_template_ids` is keyed by the Marley ENV VAR
 * NAME (e.g. "RESEND_TEMPLATE_QUOTE_EMAIL"), not the hosted template's
 * kebab-case name. scripts/create-resend-templates.mjs carries both per
 * template ({ name, envVar }); the env var is the identifier every call site
 * already uses, and it is NOT mechanically derivable from the name
 * (RESEND_TEMPLATE_COMPLETION_CERT ↔ "completion-certificate",
 * RESEND_TEMPLATE_CREW_INVITE ↔ "crew-portal-invite"), so keying by anything
 * else would need a 28-row mapping table that drifts. A --brand run of that
 * script pushes templates under brand-prefixed hosted NAMES ("pitmans-quote-
 * email" — names are the PATCH match key, so Marley's set is never touched)
 * and records the new ids into resend_template_ids under the canonical envVar.
 */

/**
 * The hosted-template id for a brand's send, or undefined when the brand has
 * no hosted template — callers then fall back to their in-repo rendered HTML,
 * exactly as they do today for an unset env var.
 *
 * Fallback runs to the env var ONLY for the default brand (or no brand): the
 * env vars point at Marley's hosted set, and sending Marley's template to
 * another brand's customer is precisely the §3.5 leak class. A non-default
 * brand missing a key therefore renders the brand-aware inline HTML rather
 * than borrowing Marley's design. Marley's live wiring changes by exactly
 * nothing. Note the group pseudo-brand: group comms keep Marley's identity
 * (PRD §11.10) — its callers pass null/undefined here, and its brands row
 * carries no template ids, so passing it degrades to inline HTML, never to a
 * silent cross-brand template.
 */
export function templateIdFor(brand: Brand | null | undefined, envName: string): string | undefined {
  if (brand && brand.slug !== DEFAULT_BRAND) {
    return brand.resendTemplateIds[envName] || undefined;
  }
  return process.env[envName] || undefined;
}
