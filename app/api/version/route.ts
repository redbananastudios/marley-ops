import { NextResponse } from "next/server";

/**
 * The RUNNING server's build stamp. The client bundle carries its own baked
 * copy of NEXT_PUBLIC_BUILD_SHA — when the two stop matching, a new deploy
 * has landed and the in-app update banner offers a reload. Public + tiny by
 * design (a short git SHA reveals nothing): the proxy matcher exempts this
 * route so an installed PWA with an expired session still gets an honest
 * answer instead of a login redirect.
 */

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    { sha: process.env.NEXT_PUBLIC_BUILD_SHA ?? "dev" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
