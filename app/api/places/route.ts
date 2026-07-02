import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Server-side Google Places Autocomplete proxy. Keeps GOOGLE_MAPS_API_KEY off the
 * client entirely (no NEXT_PUBLIC key, no referrer restriction to manage). Reuses
 * the same key that powers /api/maps mileage.
 *
 * GET /api/places?q=<input>&kind=address|postcode
 *   -> { ok, predictions: [{ id, description, main, secondary }] }
 *
 * Fails soft: on any error it returns ok:false with an empty list, so the input
 * still works as a plain text field.
 */

const EMPTY = { ok: false as const, predictions: [] as never[] };

export async function GET(req: Request) {
  if (!(await requireApiUser())) return NextResponse.json(EMPTY, { status: 401 });
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return NextResponse.json(EMPTY, { status: 200 });

  const { searchParams } = new URL(req.url);
  const q = (searchParams.get("q") ?? "").trim();
  const kind = searchParams.get("kind") === "postcode" ? "postcode" : "address";
  if (q.length < 3) return NextResponse.json({ ok: true, predictions: [] }, { status: 200 });

  // address -> street-level results; postcode -> regions (includes postal codes).
  const types = kind === "postcode" ? "(regions)" : "address";
  const url =
    `https://maps.googleapis.com/maps/api/place/autocomplete/json` +
    `?input=${encodeURIComponent(q)}&types=${encodeURIComponent(types)}` +
    `&components=country:gb&language=en-GB&key=${key}`;

  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return NextResponse.json(EMPTY, { status: 200 });
    const json = (await res.json()) as {
      status?: string;
      predictions?: {
        place_id: string;
        description: string;
        structured_formatting?: { main_text?: string; secondary_text?: string };
      }[];
    };
    if (json.status !== "OK" && json.status !== "ZERO_RESULTS") {
      return NextResponse.json(EMPTY, { status: 200 });
    }
    const predictions = (json.predictions ?? []).map((p) => ({
      id: p.place_id,
      description: p.description,
      main: p.structured_formatting?.main_text ?? p.description,
      secondary: p.structured_formatting?.secondary_text ?? "",
    }));
    return NextResponse.json({ ok: true, predictions }, { status: 200 });
  } catch {
    return NextResponse.json(EMPTY, { status: 200 });
  }
}
