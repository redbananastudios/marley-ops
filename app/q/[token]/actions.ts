"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  acceptQuoteOnline,
  declineQuoteOnline,
  reportDepositSent,
  type AcceptOutcome,
} from "@/lib/quote/accept-flow";

/**
 * PUBLIC actions — the customer at /q/<token>. No session: the unguessable
 * token (24 url-safe random chars) is the credential, and the flow core is
 * idempotent, so replays/double-taps can't create anything twice.
 */
export async function acceptQuoteAction(token: string, fullName: string): Promise<AcceptOutcome> {
  const sb = createAdminClient();
  const h = await headers();
  const ip = (h.get("x-forwarded-for") ?? "").split(",")[0].trim() || null;

  const result = await acceptQuoteOnline(sb, token, fullName, ip);
  if (result.ok) revalidatePath(`/q/${token}`);
  return result;
}

/** Customer declines with a reason — feeds the loss breakdown and stops chasing. */
export async function declineQuoteAction(
  token: string,
  reason: string,
  note?: string,
): Promise<{ ok: boolean; error?: string }> {
  const sb = createAdminClient();
  const result = await declineQuoteOnline(sb, token, reason, note);
  if (result.ok) revalidatePath(`/q/${token}`);
  return result;
}

/** Customer's "I've sent the bank transfer" — pauses reminders, queues the check. */
export async function reportDepositSentAction(
  token: string,
): Promise<{ ok: boolean; error?: string }> {
  const sb = createAdminClient();
  const result = await reportDepositSent(sb, token);
  if (result.ok) revalidatePath(`/q/${token}`);
  return result;
}
