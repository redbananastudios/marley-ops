"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { acceptQuoteOnline, type AcceptOutcome } from "@/lib/quote/accept-flow";

/**
 * PUBLIC action — the customer accepting their quote at /q/<token>. No session:
 * the unguessable token (24 url-safe random chars) is the credential, and the
 * flow core is idempotent, so replays/double-taps can't create anything twice.
 */
export async function acceptQuoteAction(token: string, fullName: string): Promise<AcceptOutcome> {
  const sb = createAdminClient();
  const h = await headers();
  const ip = (h.get("x-forwarded-for") ?? "").split(",")[0].trim() || null;

  const result = await acceptQuoteOnline(sb, token, fullName, ip);
  if (result.ok) revalidatePath(`/q/${token}`);
  return result;
}
