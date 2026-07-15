/**
 * Card-payment attempt lifecycle — SERVER ONLY.
 * PRD: docs/takepayments-card-payments-prd.md.
 *
 * One row in card_payments per hand-off to the takepayments Hosted Payment
 * Page; the row id doubles as the gateway `transactionUnique`, so the browser
 * return, the server callback and the reconcile cron all map back to the same
 * row and race safely through one atomic pending→terminal claim.
 *
 * Money truth stays on quotes.deposit_paid_at — a successful settle calls the
 * existing markDepositPaid() (confirmed status, Zoho record, customer email,
 * push, chase close). This module never duplicates that pipeline.
 *
 * Hard policy: one-off SALE only, no stored credentials. The only card data
 * persisted is what the gateway returns (masked number, scheme, auth code).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { getBusinessSettings } from "@/lib/settings";
import { sendOpsAlert, dispatchComm } from "@/lib/comms/dispatch";
import { brandedEmailHtml } from "@/lib/comms/branded-shell";
import { fetchQuoteByToken, fetchQuoteById, markDepositPaid } from "@/lib/quote/accept-flow";
import {
  buildHostedSaleFields,
  directRequest,
  getTakepaymentsConfig,
  verifySignedResponse,
  RC_SUCCESS,
  type GatewayResponse,
} from "@/lib/payments/takepayments";

type Sb = SupabaseClient<Database>;
type CardPaymentRow = Database["public"]["Tables"]["card_payments"]["Row"];

const appUrl = (): string =>
  (process.env.NEXT_PUBLIC_APP_URL || "https://ops.marleymoves.co.uk").replace(/\/$/, "");

/* ------------------------------------------------------------- pure guards */

/**
 * The amount takepayments reports on a "successful" callback must equal the
 * pence we signed into the request. A mismatch means tampering or a wrong-row
 * map — never mark it paid. Pure so it's unit-tested without a gateway.
 */
export function successAmountMatches(reportedPence: unknown, expectedPence: number): boolean {
  const received = Number(reportedPence);
  return Number.isFinite(received) && Math.round(received) === expectedPence;
}

/**
 * Validate a refund request against a paid row. Returns an error string or
 * null when the refund is allowed. Pure — the source of truth for both the
 * server action and its tests.
 */
export function refundBoundsError(
  input: { status: string; hasXref: boolean; remainingPence: number; amountPence: number; reason: string },
): string | null {
  if (!["paid", "partially_refunded"].includes(input.status)) {
    return "Only a paid card payment can be refunded.";
  }
  if (!input.hasXref) return "No gateway reference stored — refund via the MMS.";
  const amount = Math.round(input.amountPence);
  if (!Number.isInteger(amount) || amount <= 0 || amount > input.remainingPence) {
    return `Amount must be between 1p and £${(input.remainingPence / 100).toFixed(2)}.`;
  }
  if (!input.reason.trim()) return "A reason is required.";
  return null;
}

/* ------------------------------------------------------------- availability */

/** Kill switch + env creds — both required before /q renders the card button. */
export async function cardPaymentsAvailable(sb: Sb): Promise<boolean> {
  if (!getTakepaymentsConfig()) return false;
  const { data } = await sb
    .from("business_settings")
    .select("card_payments_enabled")
    .eq("id", true)
    .maybeSingle();
  return data?.card_payments_enabled === true;
}

/* ------------------------------------------------------------- start */

export type StartCardPaymentOutcome =
  | { ok: true; url: string; fields: Record<string, string> }
  | { ok: false; error: string };

/**
 * Mint a payment attempt for the /q customer. Any previous pending attempt is
 * retired first (partial unique index enforces one live attempt per quote).
 *
 * `testAmountPence` is the simulator override — the test merchant account maps
 * amount ranges to outcomes and £100.00 sits in the DECLINE range, so E2E needs
 * a success-range amount. Only the admin test button may pass it, and only in
 * test mode; the public /q action never does.
 */
export async function startCardPayment(
  sb: Sb,
  token: string,
  opts?: { testAmountPence?: number },
): Promise<StartCardPaymentOutcome> {
  const config = getTakepaymentsConfig();
  if (!config || !(await cardPaymentsAvailable(sb))) {
    return { ok: false, error: "Card payments aren't available right now." };
  }

  const quote = await fetchQuoteByToken(sb, token);
  if (!quote || quote.status !== "accepted") return { ok: false, error: "Quote not found." };
  if (quote.deposit_paid_at) return { ok: false, error: "This deposit has already been paid." };

  const settings = await getBusinessSettings(sb);
  const deposit = quote.deposit_amount ?? settings.defaultDeposit;
  let amountPence = Math.round(deposit * 100);
  if (opts?.testAmountPence && config.testMode) amountPence = Math.round(opts.testAmountPence);
  if (!Number.isInteger(amountPence) || amountPence <= 0) {
    return { ok: false, error: "No deposit amount is set for this quote." };
  }

  // Retire any stale pending attempt so the partial unique index lets us mint.
  await sb
    .from("card_payments")
    .update({ status: "abandoned", response_message: "superseded by a new attempt" })
    .eq("quote_id", quote.id)
    .eq("status", "pending");

  const { data: row, error } = await sb
    .from("card_payments")
    .insert({
      quote_id: quote.id,
      lead_id: quote.lead_id,
      client_id: quote.client_id,
      kind: "deposit",
      amount_pence: amountPence,
      status: "pending",
    })
    .select("id")
    .single();
  if (error || !row) return { ok: false, error: "Couldn't start the payment — try again." };

  const built = buildHostedSaleFields({
    config,
    amountPence,
    transactionUnique: row.id,
    orderRef: `${quote.quote_ref} deposit`,
    redirectUrl: `${appUrl()}/api/card/return`,
    callbackUrl: `${appUrl()}/api/card/callback`,
    customerName: quote.customer_name,
    customerEmail: quote.customer_email,
  });
  return { ok: true, url: built.url, fields: built.fields };
}

/* ------------------------------------------------------------- settle */

export type SettleOutcome =
  | { ok: true; state: "paid" | "already_terminal" }
  | { ok: true; state: "declined"; message: string }
  | { ok: false; error: string };

/**
 * Apply a VERIFIED gateway result to its attempt row. Idempotent and race-safe:
 * the status='pending' conditional update is the claim — whoever loses simply
 * reads the terminal row. Callers must have verified the signature already.
 */
export async function settleCardPayment(sb: Sb, fields: GatewayResponse): Promise<SettleOutcome> {
  const rowId = fields.transactionUnique;
  if (!rowId) return { ok: false, error: "missing transactionUnique" };

  const { data: row } = await sb.from("card_payments").select("*").eq("id", rowId).maybeSingle();
  if (!row) return { ok: false, error: "unknown payment attempt" };
  if (row.status !== "pending") return { ok: true, state: "already_terminal" };

  const responseCode = Number(fields.responseCode);
  const success = responseCode === RC_SUCCESS;

  // Paranoia gate on success: the gateway must have taken exactly our amount.
  if (success) {
    if (!successAmountMatches(fields.amountReceived ?? fields.amount, row.amount_pence)) {
      await sendOpsAlert(`Card payment AMOUNT MISMATCH — attempt ${row.id.slice(0, 8)}`, [
        `takepayments reported a successful payment of <strong>${fields.amountReceived ?? "?"}</strong> pence against an attempt for <strong>${row.amount_pence}</strong> pence (quote ${row.quote_id}).`,
        `The attempt has NOT been marked paid — check the MMS and reconcile manually.`,
      ]);
      return { ok: false, error: "amount mismatch" };
    }
  }

  const patch = {
    status: success ? "paid" : "failed",
    gateway_xref: fields.xref ?? null,
    gateway_transaction_id: fields.transactionID ?? null,
    response_code: Number.isFinite(responseCode) ? responseCode : null,
    response_message: (fields.responseMessage ?? "").slice(0, 512) || null,
    card_number_mask: fields.cardNumberMask ?? null,
    card_scheme: fields.cardScheme ?? null,
    authorisation_code: fields.authorisationCode ?? null,
    settled_at: success ? new Date().toISOString() : null,
  };

  // Atomic claim — first writer wins; a replayed callback is a no-op.
  const { data: claimed, error: claimErr } = await sb
    .from("card_payments")
    .update(patch)
    .eq("id", row.id)
    .eq("status", "pending")
    .select("id");
  if (claimErr) return { ok: false, error: claimErr.message };
  if (!claimed?.length) return { ok: true, state: "already_terminal" };

  if (!success) {
    return { ok: true, state: "declined", message: fields.responseMessage ?? "declined" };
  }

  // Money landed — run the existing paid pipeline. `already: true` here means
  // the deposit was ALSO marked paid another way (e.g. office BACS tap) while
  // the card was mid-flight: real money took twice → refund decision, loudly.
  const paid = await markDepositPaid(sb, row.quote_id, {
    method: "card",
    actorId: null,
    recordInZoho: true,
  });
  if (paid.already) {
    await raiseDoublePaymentAlert(sb, row);
  } else if (!paid.ok) {
    await sendOpsAlert(`Card paid but pipeline FAILED — attempt ${row.id.slice(0, 8)}`, [
      `takepayments took the deposit for quote ${row.quote_id} but marking it paid failed: ${paid.error ?? "unknown"}.`,
      `Fix manually: the money IS taken (xref ${fields.xref ?? "?"}).`,
    ]);
  }
  return { ok: true, state: "paid" };
}

async function raiseDoublePaymentAlert(sb: Sb, row: CardPaymentRow): Promise<void> {
  const quote = await fetchQuoteById(sb, row.quote_id);
  const ref = quote?.quote_ref ?? row.quote_id.slice(0, 8);
  if (quote?.lead_id) {
    await sb.from("follow_ups").insert({
      lead_id: quote.lead_id,
      client_id: quote.client_id,
      quote_id: quote.id,
      reason: "custom",
      due_at: new Date().toISOString(),
      source: "card_payment",
      notes: `Deposit for ${ref} was paid twice — once by card (£${(row.amount_pence / 100).toFixed(2)}, refundable in the lead's Payments card) and once another way. Decide which payment to refund.`,
    } as never);
  }
  await sendOpsAlert(`DOUBLE deposit payment — ${ref}`, [
    `A card payment of £${(row.amount_pence / 100).toFixed(2)} succeeded for <strong>${ref}</strong>, but the deposit was already marked paid another way.`,
    `A refund-decision follow-up has been raised — refund one of the two payments.`,
  ]);
}

/* ------------------------------------------------------------- verify + settle */

export type CardReturnState = "ok" | "failed" | "error";

/**
 * Shared entry for the return + callback routes: verify the signature, settle,
 * map to a customer-safe state. Never throws.
 */
export async function handleGatewayMessage(
  sb: Sb,
  rawFields: GatewayResponse,
): Promise<{ state: CardReturnState; token: string | null }> {
  const config = getTakepaymentsConfig();
  let token: string | null = null;
  try {
    if (!config) return { state: "error", token };
    const verified = verifySignedResponse(rawFields, config.signatureKey);
    if (!verified) {
      console.warn(
        JSON.stringify({ evt: "card_payment.bad_signature", tu: rawFields.transactionUnique ?? null }),
      );
      return { state: "error", token };
    }

    // Recover the /q token for the redirect (row → quote → accept_token).
    if (verified.transactionUnique) {
      const { data: row } = await sb
        .from("card_payments")
        .select("quote_id")
        .eq("id", verified.transactionUnique)
        .maybeSingle();
      if (row) {
        const { data: q } = await sb
          .from("quotes")
          .select("accept_token")
          .eq("id", row.quote_id)
          .maybeSingle();
        token = (q?.accept_token as string | null) ?? null;
      }
    }

    const outcome = await settleCardPayment(sb, verified);
    if (!outcome.ok) return { state: "error", token };
    if (outcome.state === "declined") return { state: "failed", token };
    return { state: "ok", token };
  } catch (err) {
    console.error(
      JSON.stringify({
        evt: "card_payment.handle_error",
        error: err instanceof Error ? err.message : "unknown",
      }),
    );
    return { state: "error", token };
  }
}

/* ------------------------------------------------------------- refund */

export type RefundOutcome = { ok: true; refundedPence: number } | { ok: false; error: string };

/**
 * Refund a paid card attempt (full or partial) back to the original card.
 * Same-day unsettled transactions are CANCELled instead (no transaction fee);
 * the gateway rejects a CANCEL once settled, and we fall through to
 * REFUND_SALE. Gateway-side over-refund protection backs up our own guard.
 */
export async function refundCardPayment(
  sb: Sb,
  input: { paymentId: string; amountPence: number; reason: string; actorId: string },
): Promise<RefundOutcome> {
  const config = getTakepaymentsConfig();
  if (!config) return { ok: false, error: "takepayments isn't configured." };

  const { data: row } = await sb
    .from("card_payments")
    .select("*")
    .eq("id", input.paymentId)
    .maybeSingle();
  if (!row) return { ok: false, error: "Payment not found." };

  const remaining = row.amount_pence - row.refunded_pence;
  const amount = Math.round(input.amountPence);
  const guard = refundBoundsError({
    status: row.status,
    hasXref: !!row.gateway_xref,
    remainingPence: remaining,
    amountPence: amount,
    reason: input.reason,
  });
  if (guard) return { ok: false, error: guard };
  const reason = input.reason.trim();
  const xref = row.gateway_xref!; // guard above proved it's present

  const fullAndUnsettledToday = amount === row.amount_pence && row.refunded_pence === 0;
  let response: GatewayResponse | null = null;
  let voided = false;

  if (fullAndUnsettledToday) {
    try {
      const cancel = await directRequest(config, { action: "CANCEL", xref });
      if (Number(cancel.responseCode) === RC_SUCCESS) {
        response = cancel;
        voided = true;
      }
    } catch {
      // CANCEL is a fee optimisation only — fall through to a normal refund.
    }
  }

  if (!response) {
    try {
      const refund = await directRequest(config, {
        action: "REFUND_SALE",
        xref,
        amount,
      });
      if (Number(refund.responseCode) !== RC_SUCCESS) {
        return { ok: false, error: `Gateway declined the refund: ${refund.responseMessage ?? "unknown"}` };
      }
      response = refund;
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Gateway unreachable — try again." };
    }
  }

  const refundedPence = row.refunded_pence + amount;
  const now = new Date().toISOString();
  await sb
    .from("card_payments")
    .update({
      status: voided ? "voided" : refundedPence >= row.amount_pence ? "refunded" : "partially_refunded",
      refunded_pence: refundedPence,
      refund_reason: reason.slice(0, 512),
      refunded_by: input.actorId,
      refunded_at: now,
    })
    .eq("id", row.id);

  const quote = await fetchQuoteById(sb, row.quote_id);
  const label = `£${(amount / 100).toFixed(2)}`;
  if (row.lead_id) {
    await sb.from("activities").insert({
      lead_id: row.lead_id,
      client_id: row.client_id,
      actor_id: input.actorId,
      type: "note",
      summary: `Card deposit ${voided ? "voided" : "refunded"} ${label}${row.card_number_mask ? ` to ${row.card_number_mask.slice(-8)}` : ""} — ${reason}`,
      meta: { card_payment_id: row.id, amount_pence: amount, voided },
    } as never);
  }
  await sb.from("events_log").insert({
    actor_id: input.actorId,
    entity_type: "card_payment",
    entity_id: row.id,
    action: voided ? "voided" : "refunded",
    diff: { amount_pence: amount, reason } as never,
  } as never);

  // Customer note — duplicate-guarded like every other send.
  if (quote?.customer_email) {
    const firstName = (quote.customer_name ?? "").trim().split(/\s+/)[0] || undefined;
    await dispatchComm(sb, input.actorId, {
      channel: "email",
      to: quote.customer_email,
      subject: `Your ${label} refund from Marley Moves (${quote.quote_ref})`,
      bodyText: `We've refunded ${label} to your card${row.card_number_mask ? ` ending ${row.card_number_mask.slice(-4)}` : ""}. It normally shows within 3–5 working days. Any questions, call us on 01747 637070.`,
      bodyHtml: brandedEmailHtml({
        preheader: `${label} refunded to your card`,
        greeting: firstName,
        headline: "Your refund is on its way",
        paragraphs: [
          `We've refunded ${label} to your card${row.card_number_mask ? ` ending ${row.card_number_mask.slice(-4)}` : ""}. It normally appears on your statement within 3–5 working days.`,
          `Any questions at all, just reply to this email or call us on 01747 637070.`,
        ],
      }),
      leadId: row.lead_id ?? undefined,
      quoteId: row.quote_id,
      clientId: row.client_id ?? undefined,
    });
  }

  return { ok: true, refundedPence: amount };
}

/* ------------------------------------------------------------- reconcile */

/**
 * Safety net for missed callbacks (the gateway doesn't document retries) and
 * abandoned HPP tabs: QUERY every pending attempt older than 10 minutes and
 * settle it from the gateway's answer; attempts the gateway has never seen
 * are swept to `abandoned` after 24 h.
 */
export async function reconcileCardPayments(
  sb: Sb,
): Promise<{ checked: number; settled: number; abandoned: number }> {
  const config = getTakepaymentsConfig();
  const out = { checked: 0, settled: 0, abandoned: 0 };
  if (!config) return out;

  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: rows } = await sb
    .from("card_payments")
    .select("*")
    .eq("status", "pending")
    .lt("created_at", tenMinAgo)
    .limit(25);

  for (const row of rows ?? []) {
    out.checked++;
    let fields: GatewayResponse | null = null;
    try {
      fields = await directRequest(config, { action: "QUERY", transactionUnique: row.id });
    } catch {
      continue; // transport blip — next run retries
    }
    const found = Number(fields.responseCode) === RC_SUCCESS || fields.xref;
    if (found && fields.transactionUnique === row.id) {
      const outcome = await settleCardPayment(sb, fields);
      if (outcome.ok && outcome.state === "paid") out.settled++;
    } else if (row.created_at < dayAgo) {
      await sb
        .from("card_payments")
        .update({ status: "abandoned", response_message: "no gateway record after 24h" })
        .eq("id", row.id)
        .eq("status", "pending");
      out.abandoned++;
    }
  }
  return out;
}
