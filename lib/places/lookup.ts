/**
 * Shared Place Details lookup — turns a Google place_id (from the /api/places
 * autocomplete) into the separated address parts. Used by the client address block
 * and by the lead/quote address fields so they all resolve an address the same way.
 * Fails soft: returns null on any error so callers keep what the user typed.
 */

export interface AddressParts {
  line1: string;
  town: string;
  county: string;
  postcode: string;
  country: string;
  formatted: string;
}

export async function lookupPlaceDetails(placeId: string): Promise<AddressParts | null> {
  if (!placeId) return null;
  try {
    const res = await fetch(`/api/places/details?placeId=${encodeURIComponent(placeId)}`, {
      signal: AbortSignal.timeout(5000),
    });
    const json = (await res.json()) as { ok: boolean; address: AddressParts };
    return json.ok ? json.address : null;
  } catch {
    return null;
  }
}
