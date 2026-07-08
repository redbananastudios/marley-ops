/**
 * Server-safe address-string parsing — shared by the client AddressFields block and
 * the server actions that seed structured addresses from one-line lead strings, so
 * "42 Princess Road, London, NW6 5QX" always splits the same way everywhere.
 */

export interface ParsedAddress {
  line1: string;
  town: string;
  county: string;
  postcode: string;
  country: string;
}

export const BLANK_PARSED_ADDRESS: ParsedAddress = {
  line1: "",
  town: "",
  county: "",
  postcode: "",
  country: "United Kingdom",
};

/** Full UK postcode, tolerant of the internal space (e.g. "SP7 9PX", "ba80tg"). */
export const UK_POSTCODE_FULL = /\b([A-Za-z]{1,2}\d[A-Za-z\d]?)\s*(\d[A-Za-z]{2})\b/;
/** Bare outward code only (e.g. "SP7", "BA8", "EC1A"). */
export const UK_POSTCODE_OUTWARD = /^[A-Za-z]{1,2}\d[A-Za-z\d]?$/;

/**
 * Seed a structured address from a stored one-line string. Pulls a UK postcode into
 * the postcode field — so a lead carrying only a postcode doesn't land it in the
 * street field — and splits a trailing town when the string is comma-separated
 * (e.g. "Ash Cottage, Shaftesbury, SP7 9PX" → line1 / town / postcode).
 */
export function addressFromString(s: string | null | undefined): ParsedAddress {
  const raw = (s ?? "").trim();
  if (!raw) return { ...BLANK_PARSED_ADDRESS };

  // Bare outward code ("SP7") — straight into postcode.
  if (UK_POSTCODE_OUTWARD.test(raw)) return { ...BLANK_PARSED_ADDRESS, postcode: raw.toUpperCase() };

  let postcode = "";
  let rest = raw;
  const m = raw.match(UK_POSTCODE_FULL);
  if (m && m.index != null) {
    postcode = `${m[1]} ${m[2]}`.toUpperCase();
    rest = (raw.slice(0, m.index) + raw.slice(m.index + m[0].length))
      .replace(/^[,\s]+|[,\s]+$/g, "")
      .trim();
  }

  const parts = rest.split(",").map((p) => p.trim()).filter(Boolean);
  // With a postcode anchor and ≥2 segments, the last segment is most likely the town.
  if (postcode && parts.length >= 2) {
    return { ...BLANK_PARSED_ADDRESS, line1: parts.slice(0, -1).join(", "), town: parts[parts.length - 1], postcode };
  }
  return { ...BLANK_PARSED_ADDRESS, line1: parts.join(", "), postcode };
}
