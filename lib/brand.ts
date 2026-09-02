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

/**
 * Active customer-facing brands ('group' excluded), in sort order.
 *
 * THROWS on a query error instead of returning [] — the empty list is also the
 * legitimate "unmigrated database" answer, and one row is single-brand mode,
 * so a swallowed error is indistinguishable from both. Every `length > 1` gate
 * downstream then silently collapses to single-brand behaviour mid-failure;
 * the worst case was createLeadAction filing an office-picked Pitmans enquiry
 * as Marley off exactly that swallow (fixed 2026-09-02). Pick a caller shape:
 *
 *   - WRITE paths that decide what gets persisted → `listActiveBrandsForWrite`
 *     (refuses in the house `{ ok:false, error }` shape; never throws).
 *   - read-only display surfaces (brand filter, chips, diary colours) that can
 *     honestly degrade to no-brand-UI → `listActiveBrandsOrEmpty`.
 *   - form pages whose whole purpose is a brand-deciding write (/leads/new,
 *     /quotes/new) call this directly and fail LOUD — an error page beats a
 *     picker-less form that invites the mis-file.
 */
export async function listActiveBrands(sb: SupabaseClient): Promise<Brand[]> {
  const { data, error } = await sb
    .from("brands")
    .select(BRAND_COLUMNS)
    .eq("active", true)
    .neq("slug", GROUP_BRAND)
    .order("sort_order", { ascending: true });
  if (error) throw new Error(`brands read failed: ${error.message}`);
  return ((data ?? []) as Record<string, unknown>[]).map(mapBrand);
}

/**
 * The EXPLICIT display-only degrade: [] on a failed read, logged — never
 * silent. Correct for surfaces that merely render brand UI (filters, chips,
 * pickers on detail pages) where no-brand-UI for one request is honest and
 * harmless. NEVER use this where the result decides what gets WRITTEN — an
 * empty list reads as single-brand mode and stamps DEFAULT_BRAND.
 */
export async function listActiveBrandsOrEmpty(sb: SupabaseClient): Promise<Brand[]> {
  try {
    return await listActiveBrands(sb);
  } catch (err) {
    console.error("[brand] active-brands read failed — brand UI degrades to single-brand display for this render:", err);
    return [];
  }
}

export type ActiveBrandsResult =
  | { ok: true; brands: Brand[] }
  | { ok: false; error: string };

/**
 * The WRITE-path resolver: the brand list, or a refusal in the house action
 * shape. A server action deciding a record's brand from a failed read must
 * refuse rather than guess (the evidence bar: "could not check" never acts
 * like "single-brand mode") — callers return the error verbatim and write
 * nothing. tests/lib/brand-write-guard.test.ts pins every brand-deciding
 * action file to this resolver.
 */
export async function listActiveBrandsForWrite(sb: SupabaseClient): Promise<ActiveBrandsResult> {
  try {
    return { ok: true, brands: await listActiveBrands(sb) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Could not read the brand list, so nothing was saved: ${message}` };
  }
}

/* ------------------------------------------------------------------ colour */

/** "#RRGGBB" → [r, g, b], or null for anything else (null, "", bad format). */
const parseHex = (v: string | null): [number, number, number] | null => {
  if (!v) return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(v.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

const srgbChannel = (c: number): number => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

/** WCAG contrast of white text on `rgb` meets the 3:1 large-text/UI bar. */
const whiteTextLegible = ([r, g, b]: [number, number, number]): boolean => {
  const luminance = 0.2126 * srgbChannel(r) + 0.7152 * srgbChannel(g) + 0.0722 * srgbChannel(b);
  return 1.05 / (luminance + 0.05) >= 3;
};

/**
 * The brand's INTERACTIVE accent — the colour for CTAs, icon tiles and
 * highlight borders that carry white text/icons (first consumer: the lead
 * page's AI-survey promo card, PRD §4 /leads/[id]).
 *
 * A data rule, not a per-brand switch (this module may not name brands):
 * prefer `colourAccent`, but only when white text is actually legible on it —
 * a light accent (e.g. a yellow reserved for large flat areas, which per PRD
 * §11.4 takes dark text) falls back to `colourPrimary`. With the seeded rows
 * this yields Marley red #C03838 (byte-equal to the --color-mm-red token, so
 * Marley surfaces are unchanged) and Pitmans blue #2B2B76. Null when the row
 * carries no usable colour — callers keep their existing mm-red rendering.
 */
export function brandCtaColour(
  brand: Pick<Brand, "colourPrimary" | "colourAccent"> | null | undefined,
): string | null {
  if (!brand) return null;
  const accent = parseHex(brand.colourAccent);
  if (accent && whiteTextLegible(accent)) return brand.colourAccent;
  const primary = parseHex(brand.colourPrimary);
  if (primary && whiteTextLegible(primary)) return brand.colourPrimary;
  return null;
}

/** `hex` darkened for hover states (mirrors mm-red → mm-red-deep, ≈ ×0.78). */
export function brandCtaColourDeep(hex: string): string {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  const shade = rgb.map((c) => Math.round(c * 0.78));
  return "#" + shade.map((c) => c.toString(16).padStart(2, "0")).join("");
}

/** `rgba()` of `hex` at `alpha` — translucent borders and glows. */
export function hexWithAlpha(hex: string, alpha: number): string {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
}

/**
 * THE single-brand invariant switch (docs/multi-brand-prd.md §1): every brand
 * UI gate hangs off this. With one active brand it returns false and the app
 * must render byte-identical to today — no chips, no filters, no colour drift.
 * Activating a second brand row flips the entire brand UI on as a data switch;
 * deactivating it reverts everything. Never gate the payment-policy additions
 * on this — those are live for Marley regardless (PRD §1).
 *
 * Propagates listActiveBrands' throw on a failed read: reporting "false"
 * (single-brand) off an error would hide the entire brand UI mid-failure.
 * Sole caller today is the Settings page render, which fails loud with it.
 */
export async function isMultiBrand(sb: SupabaseClient): Promise<boolean> {
  return (await listActiveBrands(sb)).length > 1;
}
