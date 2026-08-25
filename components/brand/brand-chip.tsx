import { cn } from "@/lib/utils";

/**
 * Brand chip — the 20px FILLED MONOGRAM SQUARE (multi-brand PRD §2 UI
 * decisions, §4 opening rules).
 *
 * Brand-colour fill, white initial, deliberately a SQUARE (`rounded-sm`) so
 * it can never be confused with the pill-shaped status badges
 * (`rounded-pill`, see components/lead-status-badge.tsx). Visually rhymes
 * with the `SOURCES` coloured-dot palette in lib/dashboard/compute.ts. The
 * full brand name lives in the tooltip; detail-page eyebrows use the
 * `variant="eyebrow"` form, which adds the short name beside the monogram.
 *
 * Purely presentational and entirely data-driven: colour and letter come from
 * the caller's `brands`-table row, NEVER from code — this file is in the
 * brand-leak-scan manifest (scripts/brand-leak-scan.mjs) and may not contain
 * any brand's display literals.
 *
 * RENDER RULE (the single-brand invariant, PRD §1 + the TESTID CONTRACT in
 * e2e/parity/single-brand.spec.ts): the chip only ever appears in multi-brand
 * mode. Callers gate on `isMultiBrand()` / `activeBrands.length > 1`, and
 * additionally HIDE the chip when the page's brand filter is set to a single
 * brand (the segmented control already says which — PRD §2 "Chip when
 * filtered"). Belt-and-braces on the component side: the group pseudo-brand
 * and any unbranded/pre-migration row carry a null `initial` or null
 * `colourPrimary`, and the chip renders nothing for them.
 */
export interface BrandChipData {
  slug: string;
  /** Full brand name — the tooltip / accessible name. */
  name: string;
  /** Monogram letter (brands.initial); null → the chip renders nothing. */
  initial: string | null;
  /** Fill colour (brands.colour_primary); null → the chip renders nothing. */
  colourPrimary: string | null;
  /** Optional (brands.short_name); the eyebrow variant prefers it over `name`. */
  shortName?: string | null;
}

export function BrandChip({
  brand,
  size = 20,
  variant = "chip",
  className,
}: {
  /** A full `Brand` (lib/brand.ts) satisfies this shape — pass the row down. */
  brand: BrandChipData;
  /** Square edge in px. 20 default; 16 for tight dashboard sub-lines. */
  size?: number;
  /** `"eyebrow"` renders monogram + short name for detail-page eyebrows. */
  variant?: "chip" | "eyebrow";
  className?: string;
}) {
  if (!brand.initial || !brand.colourPrimary) return null;

  const monogram = (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-sm font-semibold leading-none text-white select-none"
      style={{
        width: size,
        height: size,
        backgroundColor: brand.colourPrimary,
        fontSize: Math.max(9, Math.round(size * 0.55)),
      }}
    >
      {brand.initial}
    </span>
  );

  if (variant === "eyebrow") {
    return (
      <span
        data-testid="brand-chip"
        data-brand={brand.slug}
        title={brand.name}
        className={cn(
          "inline-flex shrink-0 items-center gap-1.5 text-xs font-semibold text-foreground",
          className,
        )}
      >
        {monogram}
        {brand.shortName ?? brand.name}
      </span>
    );
  }

  return (
    <span
      data-testid="brand-chip"
      data-brand={brand.slug}
      title={brand.name}
      role="img"
      aria-label={brand.name}
      className={cn("inline-flex shrink-0", className)}
    >
      {monogram}
    </span>
  );
}
