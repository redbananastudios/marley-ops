import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/api-auth";
import { isOnboardTokenValid } from "@/lib/staff/onboard-token";
import { osPlacesConfigured, osByUprn } from "@/lib/places/os";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Server-side Google Place Details proxy — turns a place_id (from /api/places
 * autocomplete) into the SEPARATED address fields the forms bind to. Same
 * GOOGLE_MAPS_API_KEY, never exposed to the client.
 *
 * GET /api/places/details?placeId=<id>
 *   -> { ok, address: { line1, town, county, postcode, country, formatted } }
 *
 * Fails soft: any error returns ok:false + an empty address so the caller keeps
 * whatever the user typed.
 */

interface AddressOut {
  line1: string;
  town: string;
  county: string;
  postcode: string;
  country: string;
  formatted: string;
}

const EMPTY_ADDR: AddressOut = { line1: "", town: "", county: "", postcode: "", country: "", formatted: "" };

type Component = { long_name: string; short_name: string; types: string[] };

function pick(components: Component[], type: string): string {
  return components.find((c) => c.types.includes(type))?.long_name ?? "";
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  // Session (office) OR the live crew sign-up token (`jt`) — see /api/places.
  if (!(await requireApiUser()) && !(await isOnboardTokenValid(searchParams.get("jt")))) {
    return NextResponse.json({ ok: false, address: EMPTY_ADDR }, { status: 401 });
  }
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return NextResponse.json({ ok: false, address: EMPTY_ADDR }, { status: 200 });

  const placeId = (searchParams.get("placeId") ?? "").trim();
  if (!placeId) return NextResponse.json({ ok: false, address: EMPTY_ADDR }, { status: 200 });

  // OS Places primary: a prediction id from /api/places is a UPRN when OS is the
  // provider. Resolve it to the full PAF address (house number + postcode). On any
  // OS error, fall through to the Google Place Details path below.
  if (osPlacesConfigured()) {
    const os = await osByUprn(placeId);
    if (os) return NextResponse.json({ ok: true, address: os }, { status: 200 });
  }

  const url =
    `https://maps.googleapis.com/maps/api/place/details/json` +
    `?place_id=${encodeURIComponent(placeId)}` +
    `&fields=address_component,formatted_address&language=en-GB&region=gb&key=${key}`;

  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return NextResponse.json({ ok: false, address: EMPTY_ADDR }, { status: 200 });
    const json = (await res.json()) as {
      status?: string;
      result?: { address_components?: Component[]; formatted_address?: string };
    };
    if (json.status !== "OK" || !json.result?.address_components) {
      return NextResponse.json({ ok: false, address: EMPTY_ADDR }, { status: 200 });
    }

    const c = json.result.address_components;
    const streetNo = pick(c, "street_number");
    const route = pick(c, "route");
    const line1 = [streetNo, route].filter(Boolean).join(" ").trim();
    // UK post town is "postal_town"; fall back through locality types.
    const town = pick(c, "postal_town") || pick(c, "locality") || pick(c, "post_town");
    // County: prefer the ceremonial/admin level 2, then level 1.
    const county = pick(c, "administrative_area_level_2") || pick(c, "administrative_area_level_1");

    const address: AddressOut = {
      line1,
      town,
      county,
      postcode: pick(c, "postal_code"),
      country: pick(c, "country") || "United Kingdom",
      formatted: json.result.formatted_address ?? "",
    };
    return NextResponse.json({ ok: true, address }, { status: 200 });
  } catch {
    return NextResponse.json({ ok: false, address: EMPTY_ADDR }, { status: 200 });
  }
}
