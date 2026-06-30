import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getBusinessSettings } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const METRES_PER_MILE = 1609.344;

async function legMiles(origin: string, destination: string, key: string): Promise<number | null> {
  const url =
    `https://maps.googleapis.com/maps/api/directions/json` +
    `?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}` +
    `&mode=driving&region=gb&key=${key}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return null;
  const json = (await res.json()) as {
    status?: string;
    routes?: { legs?: { distance?: { value?: number } }[] }[];
  };
  if (json.status !== "OK") return null;
  const metres = json.routes?.[0]?.legs?.[0]?.distance?.value;
  return typeof metres === "number" ? metres / METRES_PER_MILE : null;
}

/** POST { collectAddr, destAddr } -> { deadMiles, jobMiles, legs } via Google Directions. */
export async function POST(req: Request) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) {
    return NextResponse.json({ ok: false, error: "GOOGLE_MAPS_API_KEY not configured" }, { status: 200 });
  }

  let body: { collectAddr?: string; destAddr?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Bad JSON" }, { status: 200 });
  }
  const collectAddr = (body.collectAddr ?? "").trim();
  const destAddr = (body.destAddr ?? "").trim();
  if (!collectAddr || !destAddr) {
    return NextResponse.json({ ok: false, error: "Both addresses are required" }, { status: 200 });
  }

  const sb = await createClient();
  const { baseLocation } = await getBusinessSettings(sb);

  try {
    const [leg1, leg2, leg3] = await Promise.all([
      legMiles(baseLocation, collectAddr, key),
      legMiles(collectAddr, destAddr, key),
      legMiles(destAddr, baseLocation, key),
    ]);
    if (leg1 == null || leg2 == null || leg3 == null) {
      return NextResponse.json(
        { ok: false, error: "Could not resolve one or more legs — check the addresses." },
        { status: 200 },
      );
    }
    const round1 = (n: number) => Math.round(n * 10) / 10;
    const deadMiles = round1(leg1 + leg3);
    const jobMiles = round1(leg2);
    return NextResponse.json({
      ok: true,
      deadMiles,
      jobMiles,
      legs: [
        { label: "Base → Collection", dist: `${round1(leg1)} mi` },
        { label: "Collection → Destination", dist: `${round1(leg2)} mi` },
        { label: "Destination → Base", dist: `${round1(leg3)} mi` },
      ],
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Mileage lookup failed" },
      { status: 200 },
    );
  }
}
