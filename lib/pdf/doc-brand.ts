/**
 * PDF brand fields (multi-brand PRD §3.6) — the slim, serialisable brand
 * object the pdfmake doc-def builders take. Deliberately NOT lib/pdf/server-pdf.ts:
 * that module imports pdfmake's Node printer and embedded fonts, and several
 * doc-defs render in the BROWSER (window.pdfMake on the crew device), so the
 * shared helper must stay pure and bundle-safe for both sides.
 *
 * The parity contract, same shape as the diary's styleFor(): the default brand
 * resolves to null here, so a doc-def can only ever render it from its own
 * literal constants — today's bytes by construction, not by the seeded row
 * happening to carry the right values. Any other brand arrives as data from
 * the brands row; no doc-def may switch on a slug.
 */

import { DEFAULT_BRAND, brandCtaColour, type Brand } from "@/lib/brand";

/** Everything a branded document renders — plain data, safe across a server
 *  action boundary and into a client-built doc-def. */
export interface DocBrand {
  slug: string;
  /** Full trading name — headers and declaration copy. */
  name: string;
  /** Short name — filenames and compact markers. */
  shortName: string;
  /** The required group disclosure, shown beside the brand identity. */
  groupLine: string;
  /** Legal-entity line — the trading-name disclosure on formal documents. */
  legalLine: string;
  phone: string | null;
  /** The brand's front-door mailbox (brands.hello_from). */
  email: string | null;
  /** Public website (brands.website_url) — the quote header's web contact row. */
  websiteUrl: string | null;
  /** Heading/accent colour, WCAG-picked (brandCtaColour): the accent when
   *  white text is legible on it, else the primary — a light accent reserved
   *  for large flat areas never becomes a heading colour. */
  colour: string;
}

/**
 * Map a brands row to the doc-def shape. Returns null for the default brand —
 * the doc-defs' literal constants ARE that brand's rendering (byte-parity),
 * and a row-sourced copy could drift from them. Callers skip the brands read
 * entirely when the record's slug is DEFAULT_BRAND.
 */
export function docBrandFrom(brand: Brand): DocBrand | null {
  if (brand.slug === DEFAULT_BRAND) return null;
  return {
    slug: brand.slug,
    name: brand.name,
    shortName: brand.shortName,
    groupLine: brand.groupLine,
    legalLine: brand.legalLine,
    phone: brand.phone,
    email: brand.helloFrom,
    websiteUrl: brand.websiteUrl,
    // No usable colour on the row → the existing red rendering (the documented
    // brandCtaColour degrade), never a blank.
    colour: brandCtaColour(brand) ?? "#C03838",
  };
}

const parseHex = (v: string): [number, number, number] | null => {
  const m = /^#?([0-9a-f]{6})$/i.exec(v.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** Mix `hex` towards white by `f` (0..1) — the data rule behind the soft
 *  panel fills and on-dark subtext tints the Marley doc-defs hardcode. Text
 *  set in the brand colour on its own high-`f` tint clears WCAG 3:1 because
 *  brandCtaColour only emits white-legible (dark) colours. */
export function tintTowardsWhite(hex: string, f: number): string {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  const t = Math.min(1, Math.max(0, f));
  return (
    "#" +
    rgb
      .map((c) => Math.round(c + (255 - c) * t).toString(16).padStart(2, "0"))
      .join("")
  );
}
