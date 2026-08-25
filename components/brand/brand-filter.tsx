"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { BRAND_FILTER_PARAM } from "@/lib/brand-filter";
import { cn } from "@/lib/utils";

/**
 * Brand filter — the segmented All / <brand> / <brand> control (multi-brand
 * PRD §4 opening rules). Styled to match the house segmented-toggle pattern
 * (the Board/Table switch in components/leads/leads-board.tsx).
 *
 * The `?brand=` URL param is the single source of truth: absent means All, so
 * the control DELETES the param for All (canonical URLs) and preserves every
 * other param on write — shareable and refresh-proof by construction. Server
 * pages read it back through `parseBrandParam` (lib/brand-filter.ts) and
 * narrow queries with `applyBrandFilter`; this component never filters data
 * itself.
 *
 * Options are data-driven — one per `listActiveBrands()` row the server page
 * passes down — so a third brand appears here with zero code change. This
 * file is in the brand-leak-scan manifest (scripts/brand-leak-scan.mjs) and
 * may not contain any brand's display literals.
 *
 * RENDER RULE (the single-brand invariant, PRD §1 + the TESTID CONTRACT in
 * e2e/parity/single-brand.spec.ts): callers gate on `isMultiBrand()` /
 * `activeBrands.length > 1` — and belt-and-braces, this component renders
 * null with fewer than two brands, so a caller that forgets the gate still
 * cannot leak brand UI into single-brand mode.
 */
export interface BrandFilterOption {
  slug: string;
  /** Full brand name — the segment label fallback. */
  name: string;
  /** Preferred segment label (brands.short_name). */
  shortName?: string | null;
}

export function BrandFilter({
  brands,
  className,
}: {
  /** Active brands in sort order — `listActiveBrands()` rows satisfy this. */
  brands: BrandFilterOption[];
  className?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Belt-and-braces single-brand invariant — after the hooks (rules of hooks),
  // before anything renders.
  if (brands.length < 2) return null;

  const raw = searchParams.get(BRAND_FILTER_PARAM);
  const current = raw && brands.some((b) => b.slug === raw) ? raw : "all";

  const select = (slug: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (slug === "all") params.delete(BRAND_FILTER_PARAM);
    else params.set(BRAND_FILTER_PARAM, slug);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  const options: { slug: string; label: string }[] = [
    { slug: "all", label: "All" },
    ...brands.map((b) => ({ slug: b.slug, label: b.shortName ?? b.name })),
  ];

  return (
    <div
      role="group"
      aria-label="Brand"
      data-testid="brand-filter"
      className={cn("inline-flex rounded-md border border-[#E2E6EC] bg-[#F1F3F5] p-0.5", className)}
    >
      {options.map((option) => (
        <button
          key={option.slug}
          type="button"
          onClick={() => select(option.slug)}
          aria-pressed={current === option.slug}
          data-brand={option.slug}
          className={cn(
            "focus-ring inline-flex min-h-8 items-center rounded-[5px] px-2.5 text-xs font-semibold transition-colors",
            current === option.slug
              ? "bg-white text-[#172033] shadow-xs"
              : "text-[#667085] hover:text-[#172033]",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
