import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { handleGatewayMessage } from "@/lib/payments/card-payments";
import { parseGatewayBody } from "@/lib/payments/takepayments";

/**
 * takepayments browser return — the customer's browser POSTs the signed result
 * here after the Hosted Payment Page completes, and we bounce them back to
 * their /q page. Settling also happens here (idempotent — usually the server
 * callback has already won the claim by the time the browser lands), so the
 * customer sees the paid state even if the callback is delayed.
 *
 * PUBLIC route; the signature is the credential. On anything unverifiable we
 * still send the customer somewhere sensible rather than an error page.
 */

export const dynamic = "force-dynamic";

const appUrl = (): string =>
  (process.env.NEXT_PUBLIC_APP_URL || "https://ops.marleymoves.co.uk").replace(/\/$/, "");

export async function POST(req: Request) {
  const body = await req.text();
  const sb = createAdminClient();
  const { state, token } = await handleGatewayMessage(sb, parseGatewayBody(body));

  const dest = token
    ? `${appUrl()}/q/${encodeURIComponent(token)}?card=${state}`
    : `${appUrl()}/q/expired`; // unknown attempt — friendly not-found shape
  return NextResponse.redirect(dest, 303);
}
