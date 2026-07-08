import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getBusinessSettings } from "@/lib/settings";
import { requireApiUser } from "@/lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const METRES_PER_MILE = 1609.344;

/** GET ?dest=<address|postcode> → distance + drive time from the base (single leg). */
export async function GET(req: Request) {
  if (!(await requireApiUser())) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return NextResponse.json({ ok: false, error: "Maps not configured" }, { status: 200 });

  const params = new URL(req.url).searchParams;
  const dest = (params.get("dest") ?? "").trim();
  if (!dest) return NextResponse.json({ ok: false, error: "No destination" }, { status: 200 });
  // Optional custom origin (e.g. the job route pickup -> destination); defaults to base.
  const originParam = (params.get("origin") ?? "").trim();

  const sb = await createClient();
  const { baseLocation } = await getBusinessSettings(sb);
  const origin = originParam || baseLocation;

  try {
    const url =
      `https://maps.googleapis.com/maps/api/directions/json` +
      `?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(dest)}` +
      `&mode=driving&region=gb&key=${key}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return NextResponse.json({ ok: false, error: "Lookup failed" }, { status: 200 });
    const json = (await res.json()) as {
      status?: string;
      routes?: { legs?: { distance?: { value?: number }; duration?: { value?: number; text?: string } }[] }[];
    };
    const leg = json.routes?.[0]?.legs?.[0];
    if (json.status !== "OK" || !leg?.distance?.value) {
      return NextResponse.json({ ok: false, error: "No route found" }, { status: 200 });
    }
    const miles = Math.round((leg.distance.value / METRES_PER_MILE) * 10) / 10;
    return NextResponse.json({
      ok: true,
      miles,
      durationText: leg.duration?.text ?? null,
      durationMins: leg.duration?.value != null ? Math.round(leg.duration.value / 60) : null,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Lookup failed" },
      { status: 200 },
    );
  }
}
