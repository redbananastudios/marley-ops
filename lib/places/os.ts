/**
 * OS Places (OS Data Hub) helpers — SERVER ONLY. The Google Places UK
 * autocomplete returns street/route-level results with NO house number and NO
 * postcode; OS Places is Royal Mail PAF, so it returns full premise-level UK
 * addresses WITH postcodes. When OS_PLACES_API_KEY is set the /api/places +
 * /api/places/details proxies use OS as the primary provider and fall back to
 * Google on any error, so this is a one-line swap-out if the OS licence lapses.
 *
 * Trial note: the OS Data Hub free tier is a 60-day / 2000-transaction technical
 * trial "not for live use" — sustained production needs OS's paid Places licence
 * (or swap this provider for postcodes.io / getAddress.io). The key stays server
 * side; it never reaches the browser (same as GOOGLE_MAPS_API_KEY).
 */

const OS_BASE = "https://api.os.uk/search/places/v1";

/** A DPA (Delivery Point Address) record from OS Places. Fields are UPPERCASE. */
export interface OsDpa {
  UPRN?: string | number;
  ADDRESS?: string;
  ORGANISATION_NAME?: string;
  SUB_BUILDING_NAME?: string;
  BUILDING_NAME?: string;
  BUILDING_NUMBER?: string;
  THOROUGHFARE_NAME?: string;
  DEPENDENT_THOROUGHFARE_NAME?: string;
  POST_TOWN?: string;
  POSTCODE?: string;
}

export interface OsPrediction {
  id: string; // the UPRN — resolved back to a full address by /api/places/details
  description: string;
  main: string;
  secondary: string;
}

export interface OsAddress {
  line1: string;
  town: string;
  county: string;
  postcode: string;
  country: string;
  formatted: string;
}

export const osPlacesConfigured = (): boolean => !!process.env.OS_PLACES_API_KEY;

/** Title-case an OS ALL-CAPS segment ("BIMPORT" -> "Bimport") for display; leaves
 *  the postcode untouched (callers keep POSTCODE as-is). Not perfect for names
 *  like "McDonald", but far better than shouting the whole address. */
function tc(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .trim();
}

/** Build our separated address parts from a DPA record. */
export function dpaToAddress(d: OsDpa): OsAddress {
  const street = [d.BUILDING_NUMBER, d.DEPENDENT_THOROUGHFARE_NAME, d.THOROUGHFARE_NAME]
    .filter(Boolean)
    .join(" ");
  const line1 = [d.ORGANISATION_NAME, d.SUB_BUILDING_NAME, d.BUILDING_NAME, street]
    .filter(Boolean)
    .map((s) => tc(String(s)))
    .join(", ")
    .trim();
  return {
    line1: line1 || (d.ADDRESS ? tc(d.ADDRESS) : ""),
    town: d.POST_TOWN ? tc(d.POST_TOWN) : "",
    county: "", // OS DPA carries no county; the field stays user-editable.
    postcode: (d.POSTCODE ?? "").toUpperCase(),
    country: "United Kingdom",
    formatted: d.ADDRESS ?? "",
  };
}

function extractDpa(json: unknown): OsDpa[] {
  const results = (json as { results?: { DPA?: OsDpa }[] })?.results ?? [];
  return results.map((r) => r.DPA).filter((d): d is OsDpa => !!d);
}

/** Free-text address search. Returns predictions (id = UPRN) or null on any
 *  error, so the caller can fall back to Google. `kind` shapes the display so the
 *  postcode field's pick writes the POSTCODE while the street field's writes the
 *  full address (PlacesInput inserts `main` on select) — both carry the UPRN so
 *  the details lookup fills the rest. */
export async function osFind(
  query: string,
  kind: "address" | "postcode" = "address",
): Promise<OsPrediction[] | null> {
  const key = process.env.OS_PLACES_API_KEY;
  if (!key || query.trim().length < 3) return null;
  const url = `${OS_BASE}/find?query=${encodeURIComponent(query)}&maxresults=6&key=${key}`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    const dpas = extractDpa(await res.json());
    return dpas
      .filter((d) => d.UPRN != null && d.ADDRESS)
      .map((d) => {
        const pc = (d.POSTCODE ?? "").toUpperCase();
        return {
          id: String(d.UPRN),
          description: d.ADDRESS!,
          main: kind === "postcode" ? pc : d.ADDRESS!,
          secondary: kind === "postcode" ? d.ADDRESS! : pc,
        };
      });
  } catch {
    return null;
  }
}

/** Resolve a UPRN (a prediction id from osFind) to full address parts. Returns
 *  null on any error so the caller can fall back to Google. */
export async function osByUprn(uprn: string): Promise<OsAddress | null> {
  const key = process.env.OS_PLACES_API_KEY;
  if (!key || !/^\d+$/.test(uprn)) return null; // UPRNs are numeric
  const url = `${OS_BASE}/uprn?uprn=${encodeURIComponent(uprn)}&key=${key}`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    const dpas = extractDpa(await res.json());
    return dpas[0] ? dpaToAddress(dpas[0]) : null;
  } catch {
    return null;
  }
}
