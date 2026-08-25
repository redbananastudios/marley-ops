import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Brand layer — reads of the `brands` table (docs/multi-brand-prd.md §3.1).
 * Modelled on lib/settings.ts: interface + map + reader, per-request reads with
 * NO caching layer — a brand edit in Settings (or flipping `active`) must show
 * on the next request, and a stale cached brand on a customer-facing surface is
 * exactly the kind of wrong-logo/wrong-phone leak the brand-correctness QA lens
 * exists to catch.
 */
export interface Brand {
  slug: string;
  name: string;
  shortName: string;
  /** Diary meta-line initial ('M' | 'P'); null for the group pseudo-brand. */
  initial: string | null;
  /** "Part of the Marley Group" — the required disclosure wherever the brand logo appears. */
  groupLine: string;
  legalLine: string;
  /** Quote-ref prefix ('MM' | 'PM'); null for 'group', which mints nothing. */
  refPrefix: string | null;
  colourPrimary: string | null;
  colourAccent: string | null;
  logoUrl: string | null;
  groupLogoUrl: string | null;
  emailDomain: string | null;
  helloFrom: string | null;
  accountsFrom: string | null;
  replyDomain: string | null;
  smsSender: string | null;
  phone: string | null;
  address: string | null;
  websiteUrl: string | null;
  reviewUrl: string | null;
  termsUrl: string | null;
  /** null → business_settings.base_location stays the mileage origin. */
  baseLocation: string | null;
  /** Per-brand card switch — the office card channels and all customer card
   *  copy exist only when this AND the global business_settings kill switch
   *  are both true (PRD §11.10). */
  cardPaymentsEnabled: boolean;
  /** Xero BrandingThemeID — org-specific, never hardcoded. */
  ledgerBrandingId: string | null;
  /** Resend template ids by template key; empty until gate 13 creates the set. */
  resendTemplateIds: Record<string, string>;
  active: boolean;
  sortOrder: number;
}

/** Every pre-brand-layer row and fallback resolves to Marley. */
export const DEFAULT_BRAND = "marley";

/** The cross-brand pseudo-brand: day sheet, /join, /manual, contractor statements. */
export const GROUP_BRAND = "group";

const BRAND_COLUMNS =
  "slug, name, short_name, initial, group_line, legal_line, ref_prefix, colour_primary, colour_accent, logo_url, group_logo_url, email_domain, hello_from, accounts_from, reply_domain, sms_sender, phone, address, website_url, review_url, terms_url, base_location, card_payments_enabled, ledger_branding_id, resend_template_ids, active, sort_order";

const text = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v : null;

/** Map a snake_case `brands` row to a Brand, tolerating missing fields. */
export function mapBrand(data: Record<string, unknown>): Brand {
  const templates: Record<string, string> = {};
  const raw = data.resend_template_ids;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === "string") templates[key] = value;
    }
  }
  return {
    slug: typeof data.slug === "string" ? data.slug : DEFAULT_BRAND,
    name: typeof data.name === "string" ? data.name : "",
    shortName: typeof data.short_name === "string" ? data.short_name : "",
    initial: text(data.initial),
    groupLine: typeof data.group_line === "string" ? data.group_line : "",
    legalLine: typeof data.legal_line === "string" ? data.legal_line : "",
    refPrefix: text(data.ref_prefix),
    colourPrimary: text(data.colour_primary),
    colourAccent: text(data.colour_accent),
    logoUrl: text(data.logo_url),
    groupLogoUrl: text(data.group_logo_url),
    emailDomain: text(data.email_domain),
    helloFrom: text(data.hello_from),
    accountsFrom: text(data.accounts_from),
    replyDomain: text(data.reply_domain),
    smsSender: text(data.sms_sender),
    phone: text(data.phone),
    address: text(data.address),
    websiteUrl: text(data.website_url),
    reviewUrl: text(data.review_url),
    termsUrl: text(data.terms_url),
    baseLocation: text(data.base_location),
    cardPaymentsEnabled: data.card_payments_enabled === true,
    ledgerBrandingId: text(data.ledger_branding_id),
    resendTemplateIds: templates,
    active: data.active !== false,
    sortOrder: Number(data.sort_order ?? 0) || 0,
  };
}

/** One brand by slug. Throw-free: null on a miss — callers decide what a
 *  missing brand means (getBrandOrDefault below is the safe default). */
export async function getBrand(sb: SupabaseClient, slug: string): Promise<Brand | null> {
  const { data } = await sb
    .from("brands")
    .select(BRAND_COLUMNS)
    .eq("slug", slug)
    .maybeSingle();
  return data ? mapBrand(data as Record<string, unknown>) : null;
}

/** One brand by slug, falling back to the Marley row on a miss — the right
 *  resolver for display surfaces, where a bad slug must degrade to today's
 *  branding rather than a blank page. The final mapBrand({}) arm only exists
 *  for an unmigrated database and yields an inert Marley-slugged shell. */
export async function getBrandOrDefault(sb: SupabaseClient, slug: string): Promise<Brand> {
  return (
    (await getBrand(sb, slug)) ??
    (await getBrand(sb, DEFAULT_BRAND)) ??
    mapBrand({ slug: DEFAULT_BRAND, name: "Marley Moves", short_name: "Marley" })
  );
}

/** EVERY brands row — group and inactive included — in sort order. The
 *  Settings › Brands card reader: a config surface shows what exists, not just
 *  what's live (an inactive row is exactly the one an admin needs to see, and
 *  the group pseudo-brand's details are edited here too). Customer-facing
 *  resolution keeps using listActiveBrands/getBrand. */
export async function listAllBrands(sb: SupabaseClient): Promise<Brand[]> {
  const { data } = await sb
    .from("brands")
    .select(BRAND_COLUMNS)
    .order("sort_order", { ascending: true });
  return ((data ?? []) as Record<string, unknown>[]).map(mapBrand);
}

/** Active customer-facing brands ('group' excluded), in sort order. */
export async function listActiveBrands(sb: SupabaseClient): Promise<Brand[]> {
  const { data } = await sb
    .from("brands")
    .select(BRAND_COLUMNS)
    .eq("active", true)
    .neq("slug", GROUP_BRAND)
    .order("sort_order", { ascending: true });
  return ((data ?? []) as Record<string, unknown>[]).map(mapBrand);
}

/**
 * THE single-brand invariant switch (docs/multi-brand-prd.md §1): every brand
 * UI gate hangs off this. With one active brand it returns false and the app
 * must render byte-identical to today — no chips, no filters, no colour drift.
 * Activating a second brand row flips the entire brand UI on as a data switch;
 * deactivating it reverts everything. Never gate the payment-policy additions
 * on this — those are live for Marley regardless (PRD §1).
 */
export async function isMultiBrand(sb: SupabaseClient): Promise<boolean> {
  return (await listActiveBrands(sb)).length > 1;
}
