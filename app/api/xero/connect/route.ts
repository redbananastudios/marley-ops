import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { requireAdminApi } from "@/lib/ai/auth";
import { buildAuthoriseUrl, getXeroConfig } from "@/lib/ledger/xero-client";

/**
 * Start the Xero authorisation. Admin-only, opened by a human once per
 * organisation (and again after each 28-day Demo Company reset).
 *
 * ADMIN, not office: this connects the company's accounting system. An
 * estimator has no business granting or replacing that connection, and the
 * repo's own rule is that nav is never the security boundary — so the check is
 * here, in the handler.
 *
 * The `state` parameter is minted here and stored in an httpOnly cookie, then
 * compared on the way back. Without it this endpoint would exchange whatever
 * authorisation code an attacker put in a link, under an admin's session,
 * binding our books to an organisation of their choosing. It is short-lived and
 * single-use.
 */
export const dynamic = "force-dynamic";

export const STATE_COOKIE = "xero_oauth_state";

export async function GET() {
  if (!(await requireAdminApi())) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  if (!getXeroConfig()) {
    return NextResponse.json(
      {
        error:
          "Xero is not configured. XERO_CLIENT_ID, XERO_CLIENT_SECRET and XERO_REDIRECT_URI " +
          "must all be set in this environment.",
      },
      { status: 503 },
    );
  }

  const state = randomBytes(32).toString("hex");
  const jar = await cookies();
  jar.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax", // must survive the redirect BACK from login.xero.com
    path: "/api/xero",
    maxAge: 600, // ten minutes is longer than any honest consent takes
  });

  return NextResponse.redirect(buildAuthoriseUrl(state));
}
