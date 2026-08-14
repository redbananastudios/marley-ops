/**
 * Display formatting for customer names and UK postcodes, applied at every
 * write path (lead create/edit, website sync, client create/edit) so the
 * database never accumulates "Paul betty" / "bh218nb" variants again
 * (Peter, 2026-08-14). Pure string→string so zod schemas can use them as
 * transforms without changing the schema's input/output types.
 */

/** Title-case one name segment (already lowercased): "brien" → "Brien",
 *  with the Mc prefix special-cased ("mcdonald" → "McDonald"). "Mac" is left
 *  alone — it is ambiguous ("Macey" is not "MacEy"). */
function capSegment(seg: string): string {
  if (!seg) return seg;
  if (/^mc[a-z]{2,}$/.test(seg)) {
    return "Mc" + seg[2].toUpperCase() + seg.slice(3);
  }
  return seg[0].toUpperCase() + seg.slice(1);
}

/** Title-case one word, keeping hyphen/apostrophe boundaries:
 *  "anne-marie" → "Anne-Marie", "o'brien" → "O'Brien". */
function capWord(word: string): string {
  return word
    .split("-")
    .map((h) => h.split("'").map(capSegment).join("'"))
    .join("-");
}

/**
 * Normalise a person's name for storage: trim, collapse whitespace, and
 * title-case the words that were clearly not cased deliberately.
 *
 * Per-word rules (conservative — a hand-fixed name must survive a re-save):
 *  - all-lowercase → title-cased ("betty" → "Betty")
 *  - ALL-CAPS      → title-cased only when the WHOLE name is caps
 *                    ("JAI COOMBES" → "Jai Coombes"); a caps word inside a
 *                    mixed name is kept as typed ("PJ Harvey" — initials)
 *  - mixed-case    → kept exactly as typed ("McDonald", "van der Berg")
 */
export function formatPersonName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, " ");
  if (!name) return name;
  const words = name.split(" ");
  const alphaWords = words.filter((w) => /[a-zA-Z]/.test(w));
  const wholeNameUpper =
    alphaWords.length > 0 && alphaWords.every((w) => w === w.toUpperCase());
  return words
    .map((w) => {
      if (!/[a-zA-Z]/.test(w)) return w;
      const isLower = w === w.toLowerCase();
      const isUpper = w === w.toUpperCase();
      if (isLower || (isUpper && wholeNameUpper)) return capWord(w.toLowerCase());
      return w;
    })
    .join(" ");
}

/**
 * Normalise a UK postcode for storage: uppercase, and exactly one space
 * before the 3-character inward code ("bh218nb" / "BH21  8NB" → "BH21 8NB").
 * An outward-only partial ("sp7") is uppercased with no space. Anything that
 * does not look like a postcode at all (someone typed a town name) is
 * returned trimmed but otherwise untouched — never mangle free text.
 */
export function formatUkPostcode(raw: string): string {
  const t = raw.trim();
  if (!t) return t;
  const compact = t.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (/^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/.test(compact)) {
    return `${compact.slice(0, -3)} ${compact.slice(-3)}`;
  }
  if (/^[A-Z]{1,2}\d[A-Z\d]?$/.test(compact)) return compact;
  return t;
}

/** Null-tolerant wrappers for write sites that hold `string | null`. */
export function formatPersonNameOrNull(raw?: string | null): string | null {
  const v = raw == null ? null : formatPersonName(raw);
  return v || null;
}

export function formatUkPostcodeOrNull(raw?: string | null): string | null {
  const v = raw == null ? null : formatUkPostcode(raw);
  return v || null;
}
