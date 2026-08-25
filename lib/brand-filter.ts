import type { Brand } from "@/lib/brand";

/**
 * Server-side halves of the brand filter (multi-brand PRD §4 opening rules).
 *
 * The URL param is the single source of truth for the filter — `?brand=` is
 * shareable and refresh-proof, absent means "all". Server pages read the
 * param through `parseBrandParam` and narrow their queries through
 * `applyBrandFilter`; the client control that WRITES the param is
 * `components/brand/brand-filter.tsx`. Keeping the read half here (and
 * dependency-free) means server components never import a client module to
 * interpret the URL.
 *
 * This file is in the brand-leak-scan manifest (scripts/brand-leak-scan.mjs):
 * it must never contain any brand's display literals — slugs arrive as data
 * from the `brands` table.
 */

/** The query-string key the segmented control reads and writes. */
export const BRAND_FILTER_PARAM = "brand";

/** `"all"` or an active brand slug (PRD §10: `?brand=all|<slug>`). */
export type BrandFilterValue = string;

type SearchParamsLike =
  | URLSearchParams
  | Record<string, string | string[] | undefined>
  | undefined;

/**
 * Resolve `?brand=` to `'all'` or a verified active-brand slug.
 *
 * - Absent, `'all'`, or an UNKNOWN/inactive slug → `'all'`. A stale
 *   bookmarked URL (brand renamed, deactivated, or mistyped) must degrade to
 *   the unfiltered view, never 500 and never silently filter to nothing.
 * - Fewer than two active brands → always `'all'`, regardless of the URL.
 *   This is the single-brand invariant (PRD §1) applied to data: with one
 *   brand no filter UI exists, so no leftover URL may change what a page
 *   shows.
 *
 * Accepts either a Next.js page's resolved `searchParams` object or a
 * `URLSearchParams` (route handlers, tests).
 */
export function parseBrandParam(
  searchParams: SearchParamsLike,
  activeBrands: ReadonlyArray<Pick<Brand, "slug">>,
): BrandFilterValue {
  if (activeBrands.length < 2) return "all";
  let raw: string | undefined;
  if (searchParams instanceof URLSearchParams) {
    raw = searchParams.get(BRAND_FILTER_PARAM) ?? undefined;
  } else if (searchParams) {
    const value = searchParams[BRAND_FILTER_PARAM];
    raw = Array.isArray(value) ? value[0] : value;
  }
  if (!raw || raw === "all") return "all";
  return activeBrands.some((b) => b.slug === raw) ? raw : "all";
}

/**
 * `.eq('brand', slug)` when not `'all'`; the query untouched when `'all'`.
 *
 * The one place the filter touches a query, so every page narrows
 * identically. Generic over any PostgREST-style builder exposing `.eq`
 * (Supabase's select/filter chains satisfy this structurally), which keeps
 * this module free of runtime imports and composable with whatever
 * select/order chain the page already built:
 *
 *   let query = sb.from("leads").select("...").order("created_at");
 *   query = applyBrandFilter(query, brand);
 */
export function applyBrandFilter<Q extends { eq(column: string, value: string): Q }>(
  query: Q,
  brand: BrandFilterValue,
): Q {
  return brand === "all" ? query : query.eq("brand", brand);
}
