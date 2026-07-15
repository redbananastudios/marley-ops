import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { handleGatewayMessage } from "@/lib/payments/card-payments";
import { parseGatewayBody } from "@/lib/payments/takepayments";

/**
 * takepayments server-to-server callback — a signed copy of every transaction
 * result, POSTed independently of the customer's browser. This is the path
 * that marks deposits paid; the browser return is display-only per the guide.
 *
 * PUBLIC route (proxy matcher excludes /api/card/) — the SHA-512 signature over
 * the whole body is the credential. Anything unsigned/tampered is dropped.
 * Always answers 200 so the gateway never retries a message we've decided on;
 * genuinely missed callbacks are covered by the card-reconcile cron.
 */

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.text();
  const sb = createAdminClient();
  const { state } = await handleGatewayMessage(sb, parseGatewayBody(body));
  return NextResponse.json({ ok: state !== "error" });
}
