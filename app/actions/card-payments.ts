"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getTakepaymentsConfig } from "@/lib/payments/takepayments";
import {
  cardPaymentsAvailable,
  refundCardPayment,
  startCardPayment,
} from "@/lib/payments/card-payments";
import { paymentLinkFor } from "@/lib/payments/payment-link";
import { fetchQuoteById } from "@/lib/quote/accept-flow";
import { getBusinessSettings } from "@/lib/settings";
import { getBrandOrDefault } from "@/lib/brand";
import { dispatchComm } from "@/lib/comms/dispatch";
import { brandedEmailHtml } from "@/lib/comms/branded-shell";
import { accountsAddress, accountsFromFor } from "@/lib/comms/sender";

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

/* ------------------------------------------------- office payment link */

export type SendPaymentLinkOutcome = { ok: true; sentTo: string } | { ok: false; error: string };

/**
 * Gate 9d (PRD §3.10) — email or text the customer a card page for the
 * acceptance ask.
 *
 * For the customer who phones in unable to do a bank transfer. The link points
 * at the EXISTING /q/<token> page rather than a new surface, which is the
 * whole reason this is small: that page already resolves
 * `cardPaymentsAvailable(sb, quote.brand)` for itself and already refuses a
 * paid or cancelled quote. A link cannot therefore outlive the conditions that
 * justified sending it — if the customer pays by bank transfer in the meantime,
 * the page they open no longer offers card.
 *
 * Eligibility is `paymentLinkFor`, the same pure rule the button consults, so
 * the office can never send a link the page will refuse.
 */
export async function sendPaymentLinkAction(input: {
  quoteId: string;
  channel: "email" | "sms";
}): Promise<SendPaymentLinkOutcome> {
  const prof = await requireOffice();
  if (!prof) return { ok: false, error: "Not signed in." };

  const admin = createAdminClient();
  const quote = await fetchQuoteById(admin, input.quoteId);
  if (!quote) return { ok: false, error: "Quote not found." };

  // Both switches, resolved by the one helper that ANDs them (PRD §11.10).
  // Re-derived here rather than trusted from the client: the button being
  // rendered is not evidence the brand still has card on.
  const cardOk = await cardPaymentsAvailable(admin, quote.brand).catch(() => false);
  const settings = await getBusinessSettings(admin);
  const verdict = paymentLinkFor(quote, cardOk, settings.defaultDeposit);
  if (!verdict.ok) return { ok: false, error: verdict.reason };

  if (!quote.accept_token) {
    return { ok: false, error: "This quote has no customer link." };
  }
  const to = input.channel === "email" ? quote.customer_email : quote.customer_phone;
  if (!to) {
    return {
      ok: false,
      error: input.channel === "email" ? "No email address on file." : "No mobile number on file.",
    };
  }

  const brand = await getBrandOrDefault(admin, quote.brand);
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "https://ops.marleymoves.co.uk").replace(/\/$/, "");
  const url = `${appUrl}/q/${quote.accept_token}`;
  const amount = (verdict.amountPence / 100).toFixed(2);
  const firstName = (quote.customer_name ?? "").trim().split(/\s+/)[0] || undefined;
  const line = `You can pay the £${amount} for ${quote.quote_ref} by card here: ${url}`;

  const res = await dispatchComm(admin, prof.id, {
    channel: input.channel,
    to,
    // Money desk identity — a payment ask goes out from accounts, like every
    // other money email.
    ...(input.channel === "email"
      ? { from: accountsFromFor(brand), replyTo: accountsAddress() }
      : {}),
    subject: `Pay by card for ${quote.quote_ref}`,
    bodyText: line,
    ...(input.channel === "email"
      ? {
          bodyHtml: brandedEmailHtml({
            preheader: `Pay £${amount} by card`,
            greeting: firstName,
            headline: "Pay by card",
            paragraphs: [
              `Here is a secure link to pay £${amount} for ${quote.quote_ref} by card.`,
              `The link opens your booking page, where the card form sits under the payment section.`,
            ],
            cta: { label: `Pay £${amount} by card`, url },
            brand,
          }),
        }
      : {}),
    brand,
    leadId: quote.lead_id ?? undefined,
    quoteId: quote.id,
    clientId: quote.client_id ?? undefined,
  });

  if ("duplicate" in res) {
    return { ok: false, error: "That link was just sent — check the Comms tab before sending again." };
  }
  if (!res.ok) return { ok: false, error: res.error };
  revalidatePath("/leads", "layout");
  return { ok: true, sentTo: to };
}
