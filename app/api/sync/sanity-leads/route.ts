import { NextResponse } from "next/server";
import { syncSanityLeads } from "@/lib/sync/sanity-leads";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Manual "Sync leads" button → full sync (also refreshes existing rows). */
export async function GET() {
  const result = await syncSanityLeads();
  return NextResponse.json(result, { status: 200 });
}

export async function POST() {
  return GET();
}
