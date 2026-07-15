"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getTakepaymentsConfig } from "@/lib/payments/takepayments";
import { refundCardPayment, startCardPayment } from "@/lib/payments/card-payments";

/** Any active office user (admin/estimator) — reads. */
async function requireOffice() {
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return null;
  const { data: prof } = await sb.from("profiles").select("id, role, active").eq("id", user.id).single();
  if (!prof?.active || !["admin", "estimator"].includes(prof.role)) return null;
  return prof;
}

/** Refund (or same-day void) a card deposit — ADMIN only, reason required. */
export async function refundCardPaymentAction(input: {
  paymentId: string;
  amountPence: number;
  reason: string;
}): Promise<{ ok: boolean; error?: string }> {
  const prof = await requireOffice();
  if (!prof) return { ok: false, error: "Not signed in." };
  if (prof.role !== "admin") return { ok: false, error: "Only admins can issue refunds." };

  const admin = createAdminClient();
  const res = await refundCardPayment(admin, {
    paymentId: input.paymentId,
    amountPence: input.amountPence,
    reason: input.reason,
    actorId: prof.id,
  });
  if (res.ok) revalidatePath("/leads", "layout");
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

/* ------------------------------------------------------------- settings */

/** Toggle the card-payments kill switch (admin only). */
export async function setCardPaymentsEnabledAction(
  enabled: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const prof = await requireOffice();
  if (!prof || prof.role !== "admin") return { ok: false, error: "Only admins can change this." };
  const admin = createAdminClient();
  const { error } = await admin
    .from("business_settings")
    .update({ card_payments_enabled: enabled })
    .eq("id", true);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/settings");
  return { ok: true };
}

export interface CardPaymentsConfigView {
  configured: boolean;
  enabled: boolean;
  testMode: boolean;
  merchantIdMasked: string | null;
}

/** Settings panel view — admin only (masked merchant id + mode + toggle). */
export async function getCardPaymentsConfigAction(): Promise<CardPaymentsConfigView | null> {
  const prof = await requireOffice();
  if (!prof || prof.role !== "admin") return null;
  const config = getTakepaymentsConfig();
  const admin = createAdminClient();
  const { data } = await admin
    .from("business_settings")
    .select("card_payments_enabled")
    .eq("id", true)
    .maybeSingle();
  return {
    configured: !!config,
    enabled: data?.card_payments_enabled === true,
    testMode: config?.testMode ?? false,
    merchantIdMasked: config ? `••••${config.merchantId.slice(-4)}` : null,
  };
}

/**
 * Admin "run a test payment" — mints a real simulator attempt on your own
 * device and hands back the hosted form. TEST MODE ONLY; uses a success-range
 * amount (£1.00) because the simulator treats £100 as a decline.
 */
export async function startTestCardPaymentAction(
  token: string,
): Promise<{ ok: true; url: string; fields: Record<string, string> } | { ok: false; error: string }> {
  const prof = await requireOffice();
  if (!prof || prof.role !== "admin") return { ok: false, error: "Only admins can run a test payment." };
  const config = getTakepaymentsConfig();
  if (!config?.testMode) return { ok: false, error: "Test payments only run in test mode." };
  const admin = createAdminClient();
  // isTest tags the row so settle records the simulator charge but never touches
  // the real customer/Zoho/confirm pipeline — even against a real quote token.
  return startCardPayment(admin, token, { testAmountPence: 100, isTest: true });
}
