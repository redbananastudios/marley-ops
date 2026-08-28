"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  acceptQuoteOnline,
  confirmMoveDateOnline,
  declineQuoteOnline,
  reportDepositSent,
  settleQuoteInFull,
  type AcceptOutcome,
  type DateConfirmOutcome,
  type SettleInFullOutcome,
} from "@/lib/quote/accept-flow";
import { startCardPayment } from "@/lib/payments/card-payments";

/**
 * PUBLIC actions — the customer at /q/<token>. No session: the unguessable
 * token (24 url-safe random chars) is the credential, and the flow core is
 * idempotent, so replays/double-taps can't create anything twice.
 */
export async function acceptQuoteAction(
  token: string,
  fullName: string,
  acks?: Record<string, boolean>,
  signatureImage?: string | null,
): Promise<AcceptOutcome> {
  const sb = createAdminClient();
  const h = await headers();
  const ip = (h.get("x-forwarded-for") ?? "").split(",")[0].trim() || null;
  const userAgent = h.get("user-agent");

  const result = await acceptQuoteOnline(sb, token, fullName, ip, { acks, userAgent, signatureImage });
  if (result.ok) revalidatePath(`/q/${token}`);
  return result;
}

/**
 * Customer confirms their move date from the post-payment card (Payments
 * Policy v2 §5A). Token-authed like the accept; the CAS on
 * leads.date_confirmed_at makes replays a clean no-op.
 */
export async function confirmMoveDateAction(
  token: string,
  fullName: string,
  acks?: Record<string, boolean>,
  signatureImage?: string | null,
): Promise<DateConfirmOutcome> {
  const sb = createAdminClient();
  const h = await headers();
  const ip = (h.get("x-forwarded-for") ?? "").split(",")[0].trim() || null;
  const userAgent = h.get("user-agent");

  const result = await confirmMoveDateOnline(sb, token, fullName, ip, {
    acks,
    userAgent,
    signatureImage,
  });
  if (result.ok) revalidatePath(`/q/${token}`);
  return result;
}

/**
 * Customer chose "settle in full" at the commitment step (PRD §3.10 Addition 3).
 * Raises the T-7 balance invoice early so both are payable now — separately or
 * in one transfer. Token-authed like the rest of this file, and idempotent: a
 * double-tap finds the invoice already raised and reports that success rather
 * than an error.
 */
export async function settleInFullAction(token: string): Promise<SettleInFullOutcome> {
  const sb = createAdminClient();
  const result = await settleQuoteInFull(sb, token, null);
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

/**
 * Customer taps "Pay by card" — mint a takepayments attempt and hand back the
 * signed hosted-payment form. The amount is signed server-side from the
 * quote's deposit; nothing the browser sends can change it.
 */
export async function startCardPaymentAction(
  token: string,
): Promise<{ ok: true; url: string; fields: Record<string, string> } | { ok: false; error: string }> {
  const sb = createAdminClient();
  return startCardPayment(sb, token);
}
