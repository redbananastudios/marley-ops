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
 * UK counties/regions, so a trailing "…, County" segment is read as the COUNTY
 * rather than mislabelled as the town (Google Place Details / the edit-lead form
 * store addresses as "line1, town, county"). Deliberately EXCLUDES names that are
 * also common town/city names (Bristol, Durham, York, Lincoln, Chester…) — those
 * stay treated as the town; only unambiguous county names are listed. Compared
 * upper-cased.
 */
export const UK_COUNTIES: ReadonlySet<string> = new Set(
  [
    // England (ceremonial + metropolitan)
    "Bedfordshire", "Berkshire", "Buckinghamshire", "Cambridgeshire", "Cheshire",
    "Cornwall", "Cumbria", "Derbyshire", "Devon", "Dorset", "County Durham",
    "East Sussex", "Essex", "Gloucestershire", "Greater London", "Greater Manchester",
    "Hampshire", "Herefordshire", "Hertfordshire", "Isle of Wight", "Kent",
    "Lancashire", "Leicestershire", "Lincolnshire", "Merseyside", "Norfolk",
    "North Yorkshire", "Northamptonshire", "Northumberland", "Nottinghamshire",
    "Oxfordshire", "Rutland", "Shropshire", "Somerset", "South Yorkshire",
    "Staffordshire", "Suffolk", "Surrey", "Tyne and Wear", "Warwickshire",
    "West Midlands", "West Sussex", "West Yorkshire", "Wiltshire", "Worcestershire",
    // Historic but still written by customers
    "Avon", "Middlesex", "Cleveland", "Humberside",
    // Wales
    "Powys", "Gwynedd", "Gwent", "Clwyd", "Dyfed", "Monmouthshire", "Pembrokeshire",
    "Ceredigion", "Carmarthenshire", "Denbighshire", "Flintshire",
    // Scotland (principal areas commonly used as "county")
    "Aberdeenshire", "Angus", "Argyll and Bute", "Ayrshire", "Fife", "Highland",
    "Lanarkshire", "Moray", "Perth and Kinross", "Renfrewshire", "Scottish Borders",
    "Dumfries and Galloway", "East Lothian", "Midlothian", "West Lothian",
    // NB: Wrexham / Conwy / Stirling / Anglesey deliberately omitted — they are
    // council areas that are ALSO the town name, so stripping them as a county
    // would blank the town (same exclusion as Bristol / Durham / York).
  ].map((c) => c.toUpperCase()),
);

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

  let parts = rest.split(",").map((p) => p.trim()).filter(Boolean);

  // A trailing segment that names a known UK county is the county, not the town —
  // so "12 High Street, Bath, Somerset" reads town=Bath / county=Somerset instead
  // of mislabelling Somerset as the town (Google Places / edit-lead store
  // "line1, town, county").
  let county = "";
  if (parts.length >= 2 && UK_COUNTIES.has(parts[parts.length - 1].toUpperCase())) {
    county = parts[parts.length - 1];
    parts = parts.slice(0, -1);
  }

  // With a postcode anchor and ≥2 remaining segments, the last is most likely the town.
  if (postcode && parts.length >= 2) {
    return { ...BLANK_PARSED_ADDRESS, line1: parts.slice(0, -1).join(", "), town: parts[parts.length - 1], county, postcode };
  }
  return { ...BLANK_PARSED_ADDRESS, line1: parts.join(", "), county, postcode };
}

/**
 * Seed a structured address from a lead's TWO stored fields — the one-line address
 * and its separately-stored postcode.
 *
 * Website-sync leads keep the street+town in `address` and the postcode on its own
 * (`"58 Stokehill, Trowbridge"` + `"BA14 7TJ"`). Parsing the address alone then
 * leaves the postcode blank AND can't split the town, because addressFromString
 * anchors the town on a postcode found inside the string — so everything lands in
 * line1 (Peter, 2026-08-02: "create quote without survey" showed only the first
 * address line). Manually-entered leads already bake the postcode into the address
 * (formatAddress joins line1, town, postcode), so blindly re-appending would double
 * it into the town field. Append the separate postcode ONLY when the address string
 * doesn't already carry one; then the normal parser fills postcode + splits the town.
 */
export function addressFromLead(address: string | null | undefined, postcode: string | null | undefined): ParsedAddress {
  const a = (address ?? "").trim();
  const pc = (postcode ?? "").trim();
  // No address, or the address already carries a postcode, or no separate postcode
  // to add → parse whatever we have as-is.
  if (!a || !pc || UK_POSTCODE_FULL.test(a)) return addressFromString(a || pc);
  // A FULL separate postcode can be appended so the parser fills it AND anchors the
  // town split. A bare OUTWARD code ("SP7") can't sit mid-string (the parser only
  // recognises a bare outward as the whole string), so parse the address alone and
  // stamp the outward code onto the result — postcode filled, town stays in line1.
  if (UK_POSTCODE_FULL.test(pc)) return addressFromString(`${a}, ${pc}`);
  return { ...addressFromString(a), postcode: pc.toUpperCase() };
}
