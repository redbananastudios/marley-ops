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
import { configuredProvider } from "@/lib/ledger";
import type { Database } from "@/lib/supabase/database.types";
import { getBusinessSettings } from "@/lib/settings";
import { log } from "@/lib/log";
import { sendOpsAlert, dispatchComm } from "@/lib/comms/dispatch";
import { brandedEmailHtml } from "@/lib/comms/branded-shell";
import { accountsAddress, accountsFromFor } from "@/lib/comms/sender";
import { DEFAULT_BRAND, getBrand, getBrandOrDefault } from "@/lib/brand";
import { fetchQuoteByToken, fetchQuoteById, markDepositPaid } from "@/lib/quote/accept-flow";
import { reverseDepositVatInZoho } from "@/lib/payments/refund-vat";
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

/**
 * Turn a REFUND_SALE decline into desk-friendly copy. The common one: a same-day
 * card auth is captured-but-UNSETTLED, and the gateway won't REFUND it ("Cannot
 * REFUND this SALE transaction") — before it settles you can only VOID it in full;
 * a partial or a plain refund waits until it settles (next working day). Pure, so
 * the wording is unit-tested. `fullAttempt` = a full untouched refund that already
 * tried a VOID and had that fail too (a rarer mid-settlement edge).
 */
export function refundDeclineMessage(gatewayMessage: string | undefined | null, fullAttempt: boolean): string {
  const msg = gatewayMessage ?? "";
  if (/cannot refund/i.test(msg)) {
    return fullAttempt
      ? "This payment can't be refunded right now — it may be mid-settlement. Try again shortly, or check the takepayments MMS."
      : "This payment hasn't settled yet, so a partial refund isn't possible until it does (usually the next working day). To return money today, refund it in full — that voids the payment.";
  }
  return `Gateway declined the refund: ${msg || "unknown"}`;
}

/* ------------------------------------------------------------- availability */

/**
 * Whether the card channel is live for a given brand's quote.
 *
 * THREE things must hold, and they are deliberately ANDed (PRD §11.10): the
 * takepayments env credentials exist, the global kill switch is on, and the
 * BRAND's own switch is on.
 *
 * The brand clause was missing until 2026-08-27 (QA-20260826-07), which made
 * `brands.card_payments_enabled` a dead control: `/q` rendered the card button
 * off the global switch alone, so a brand with card deliberately OFF still got
 * the button while every one of its emails said bank transfer was the only
 * route. That is the exact combination Pitmans launches in.
 *
 * `brandSlug` omitted means the default brand — the single-brand path, where
 * this is byte-for-byte the old behaviour.
 */
export async function cardPaymentsAvailable(sb: Sb, brandSlug?: string | null): Promise<boolean> {
  if (!getTakepaymentsConfig()) return false;
  const { data } = await sb
    .from("business_settings")
    .select("card_payments_enabled")
    .eq("id", true)
    .maybeSingle();
  if (data?.card_payments_enabled !== true) return false;

  const slug = (brandSlug ?? "").trim();
  if (!slug || slug === DEFAULT_BRAND) return true;
  // A brand row that cannot be read is not a brand with card ON. Failing open
  // here would put a card button on a surface whose copy says bank-only.
  const brand = await getBrand(sb, slug).catch(() => null);
  return brand?.cardPaymentsEnabled === true;
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
  opts?: { testAmountPence?: number; isTest?: boolean },
): Promise<StartCardPaymentOutcome> {
  const config = getTakepaymentsConfig();
  if (!config) return { ok: false, error: "Card payments aren't available right now." };

  // The quote is loaded BEFORE the availability check because availability is
  // per-brand (PRD §11.10) and the brand rides on the quote. Checking first and
  // reading the brand after is what made the switch inert (QA-20260826-07).
  const quote = await fetchQuoteByToken(sb, token);
  if (!quote || quote.status !== "accepted") return { ok: false, error: "Quote not found." };
  if (!(await cardPaymentsAvailable(sb, quote.brand))) {
    return { ok: false, error: "Card payments aren't available right now." };
  }
  if (quote.deposit_paid_at) return { ok: false, error: "This deposit has already been paid." };

  const settings = await getBusinessSettings(sb);
  const deposit = quote.deposit_amount ?? settings.defaultDeposit;
  let amountPence = Math.round(deposit * 100);
  if (opts?.testAmountPence && config.testMode) amountPence = Math.round(opts.testAmountPence);
  if (!Number.isInteger(amountPence) || amountPence <= 0) {
    return { ok: false, error: "No deposit amount is set for this quote." };
  }

  // Cap attempts per quote — repeatedly minting otherwise spawns a pile of
  // abandoned rows that each fire a reconcile "verify in MMS" money alert (alert
  // amplification). A dozen is far more than a real customer ever needs.
  const { count: priorAttempts } = await sb
    .from("card_payments")
    .select("id", { count: "exact", head: true })
    .eq("quote_id", quote.id)
    .in("status", ["pending", "abandoned"]);
  if ((priorAttempts ?? 0) >= 12) {
    return { ok: false, error: "Too many payment attempts on this quote. Please call us to take your deposit." };
  }

  // Retire any stale pending attempt so the partial unique index lets us mint.
  // If that older attempt was actually PAID (customer completed two HPP tabs),
  // its callback still settles it via the abandoned-on-success path in
  // settleCardPayment, so the second charge is recorded + double-alerted — it
  // is never silently discarded.
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
      is_test: opts?.isTest === true,
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
  | { ok: true; state: "paid" }
  /** The row was already terminal (the other route won the race) — carries the
   *  row's final status so the browser-return redirect reflects the REAL
   *  outcome. Without it a declined customer whose callback settled first got
   *  bounced to ?card=ok and saw no failure explanation (caught in the
   *  2026-07-28 sandbox verification). */
  | { ok: true; state: "already_terminal"; finalStatus: string }
  | { ok: true; state: "declined"; message: string }
  | { ok: false; error: string };

/**
 * Apply a VERIFIED gateway result to its attempt row. Idempotent and race-safe:
 * the conditional `.in("status", …)` update is the claim — whoever loses simply
 * reads the terminal row. Callers must have verified the signature already.
 *
 * A SUCCESS may settle a `pending` OR an `abandoned` row: the latter is the
 * second charge of a two-tab double-payment, and recording it (then routing
 * through markDepositPaid → double-payment alert) is safer than discarding
 * real money. A decline only settles `pending`.
 */
export async function settleCardPayment(sb: Sb, fields: GatewayResponse): Promise<SettleOutcome> {
  const rowId = fields.transactionUnique;
  if (!rowId) return { ok: false, error: "missing transactionUnique" };

  const { data: row } = await sb.from("card_payments").select("*").eq("id", rowId).maybeSingle();
  if (!row) return { ok: false, error: "unknown payment attempt" };

  const responseCode = Number(fields.responseCode);
  const success = responseCode === RC_SUCCESS;

  // A success can rescue an abandoned (superseded) row; a decline can't.
  const claimFrom = success ? ["pending", "abandoned"] : ["pending"];
  if (!claimFrom.includes(row.status)) return { ok: true, state: "already_terminal", finalStatus: row.status };

  // Paranoia gate on success: the gateway must have taken exactly our amount.
  // A mismatch is never auto-confirmed — claim the row to `needs_review` (a
  // TERMINAL state, so the reconcile cron won't re-alert every tick) and alert
  // a human once to reconcile against the MMS.
  if (success && !successAmountMatches(fields.amountReceived ?? fields.amount, row.amount_pence)) {
    const { data: flagged } = await sb
      .from("card_payments")
      .update({
        status: "needs_review",
        gateway_xref: fields.xref ?? null,
        gateway_transaction_id: fields.transactionID ?? null,
        response_code: Number.isFinite(responseCode) ? responseCode : null,
        response_message: `amount mismatch: reported ${fields.amountReceived ?? fields.amount ?? "?"} vs ${row.amount_pence}`.slice(0, 512),
      })
      .eq("id", row.id)
      .in("status", claimFrom)
      .select("id");
    if (flagged?.length) {
      await sendOpsAlert(`Card payment AMOUNT MISMATCH — attempt ${row.id.slice(0, 8)}`, [
        `takepayments reported a successful payment of <strong>${fields.amountReceived ?? "?"}</strong> pence against an attempt for <strong>${row.amount_pence}</strong> pence (quote ${row.quote_id}).`,
        `The attempt is flagged <strong>needs review</strong> and NOT marked paid — check the MMS and reconcile manually.`,
      ], "money");
    }
    return { ok: false, error: "amount mismatch" };
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
    .in("status", claimFrom)
    .select("id");
  if (claimErr) return { ok: false, error: claimErr.message };
  if (!claimed?.length) {
    // Lost the claim mid-flight — re-read for the winner's terminal status
    // (the pre-claim `row` snapshot is stale by definition here).
    const { data: fresh } = await sb.from("card_payments").select("status").eq("id", row.id).maybeSingle();
    return { ok: true, state: "already_terminal", finalStatus: fresh?.status ?? row.status };
  }

  if (!success) {
    return { ok: true, state: "declined", message: fields.responseMessage ?? "declined" };
  }

  // A test attempt runs through the real simulator but MUST NOT touch the
  // customer/Zoho/confirm pipeline — it's against a real quote token.
  if (row.is_test) return { ok: true, state: "paid" };

  // Pass the gateway's masked PAN explicitly — `row` is the PRE-settle snapshot
  // (card_number_mask still null on it); the mask only lands in `patch` above, so
  // deriving the receipt's last-4 from `row` would always be null.
  await runPaidPipeline(sb, row, fields.xref ?? null, fields.cardNumberMask ?? null);
  return { ok: true, state: "paid" };
}

/**
 * Run the deposit-paid pipeline for a settled card row, isolating every failure
 * mode so a paid capture is NEVER silently orphaned. A throw inside
 * markDepositPaid (leads update, Zoho, email) becomes an ops alert here rather
 * than propagating out and leaving a `paid` card row with an unconfirmed quote
 * that the pending-only reconcile cron would never revisit.
 */
async function runPaidPipeline(
  sb: Sb,
  row: CardPaymentRow,
  xref: string | null,
  cardMask?: string | null,
): Promise<void> {
  try {
    // Money truth uses the amount actually captured (row.amount_pence), not a
    // possibly-since-edited quote.deposit_amount.
    // Prefer the mask passed by the caller (fresh from the gateway on the settle
    // path); fall back to the row's own mask (populated on reconcile-recovery).
    const mask = cardMask ?? row.card_number_mask;
    const paid = await markDepositPaid(sb, row.quote_id, {
      method: "card",
      actorId: null,
      recordInZoho: true,
      amountPence: row.amount_pence,
      // Last 4 for the receipt (masked PAN → digits only → last four).
      cardLast4: mask ? String(mask).replace(/\D/g, "").slice(-4) || null : null,
    });
    if (paid.already) {
      // Deposit was ALSO marked paid another way (BACS tap, or the two-tab
      // second charge) → real money twice → refund decision, loudly.
      await raiseDoublePaymentAlert(sb, row);
    } else if (!paid.ok) {
      await sendOpsAlert(`Card paid but pipeline FAILED — attempt ${row.id.slice(0, 8)}`, [
        `takepayments took the deposit for quote ${row.quote_id} but marking it paid failed: ${paid.error ?? "unknown"}.`,
        `Fix manually: the money IS taken (xref ${xref ?? "?"}).`,
      ], "system");
    }
  } catch (err) {
    await sendOpsAlert(`Card paid but pipeline THREW — attempt ${row.id.slice(0, 8)}`, [
      `takepayments took the deposit for quote ${row.quote_id} (xref ${xref ?? "?"}) but confirming the booking threw: ${err instanceof Error ? err.message : "unknown"}.`,
      `The card row is marked paid; confirm the lead + record the Zoho payment manually.`,
    ], "system");
  }
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
      // Two very different jobs share (custom, card_payment): this refund
      // DECISION, and the "raise a Zoho credit note by hand" reminder from
      // refund-vat.ts. Without a discriminator the refund closer below shut both,
      // retiring an accounting job nobody had done. kind mirrors the pattern the
      // commitment_chase tasks already use.
      metadata: { kind: "double_payment" },
      notes: `Deposit for ${ref} was paid twice — once by card (£${(row.amount_pence / 100).toFixed(2)}, refundable in the lead's Payments card) and once another way. Decide which payment to refund.`,
    } as never);
  }
  await sendOpsAlert(`DOUBLE deposit payment — ${ref}`, [
    `A card payment of £${(row.amount_pence / 100).toFixed(2)} succeeded for <strong>${ref}</strong>, but the deposit was already marked paid another way.`,
    `A refund-decision follow-up has been raised — refund one of the two payments.`,
  ], "money");
}

/* ------------------------------------------------------------- verify + settle */

export type CardReturnState = "ok" | "failed" | "error";

/**
 * Map an already-terminal row's real status (the race winner's outcome) to the
 * customer-facing redirect state. WHITELIST, not blacklist: only a genuine
 * `paid` row may show the success page. Every other terminal status — a decline
 * (`failed`), an amount-mismatch hold (`needs_review`), a superseded attempt
 * (`abandoned`), a void/refund, or a `pending` fallback from a failed re-read —
 * must NOT render success, or a customer who did not pay is told they did.
 * `failed` gets the retry copy; anything else non-paid gets the call-us
 * ("error") copy. Pure, so this money-critical redirect table is unit-tested
 * without a gateway.
 */
export function terminalStatusToReturnState(finalStatus: string): CardReturnState {
  if (finalStatus === "paid") return "ok";
  if (finalStatus === "failed") return "failed";
  return "error";
}

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
    // Race-loser path: reflect what the winner ACTUALLY recorded, via a strict
    // whitelist. A declined attempt must land back on /q as card=failed even
    // when the callback settled it first; a superseded (abandoned) row hit by a
    // late decline, a needs_review hold, or a stale-read `pending` fallback all
    // map to "error" — only a genuine `paid` winner is ever shown success.
    if (outcome.state === "already_terminal") {
      return { state: terminalStatusToReturnState(outcome.finalStatus), token };
    }
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
 * the gateway rejects a CANCEL once settled, and we fall through to REFUND_SALE.
 *
 * Concurrency-safe (a double-click / two tabs must never double-refund a card):
 * we ATOMICALLY reserve the amount by advancing refunded_pence with an
 * optimistic guard BEFORE calling the gateway. The loser of a race sees 0 rows
 * and aborts before any money moves. If the gateway then declines or errors, we
 * roll the reservation back.
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
  const reservedPence = row.refunded_pence + amount;

  // ATOMIC RESERVE — advance refunded_pence only if it hasn't changed since our
  // read AND the row is still refundable. Postgres serialises concurrent writes
  // on the row: a racing refund re-evaluates its guard against the committed
  // (already-advanced) value and matches 0 rows, so it aborts here, before the
  // gateway call. This is the lock that prevents a double-refund.
  const { data: reserved } = await sb
    .from("card_payments")
    .update({ refunded_pence: reservedPence })
    .eq("id", row.id)
    .eq("refunded_pence", row.refunded_pence)
    .in("status", ["paid", "partially_refunded"])
    .select("id");
  if (!reserved?.length) {
    return { ok: false, error: "That refund is already being processed — refresh and check the amount." };
  }

  const rollback = () =>
    sb.from("card_payments").update({ refunded_pence: row.refunded_pence }).eq("id", row.id).eq("refunded_pence", reservedPence);

  const fullAndUnsettledToday = amount === row.amount_pence && row.refunded_pence === 0;
  let response: GatewayResponse | null = null;
  let voided = false;

  try {
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
      const refund = await directRequest(config, { action: "REFUND_SALE", xref, amount });
      if (Number(refund.responseCode) !== RC_SUCCESS) {
        await rollback();
        return { ok: false, error: refundDeclineMessage(refund.responseMessage, fullAndUnsettledToday) };
      }
      response = refund;
    }
  } catch (err) {
    // AMBIGUOUS OUTCOME — the REFUND_SALE/CANCEL may have COMMITTED at the gateway
    // before the transport failed (a timeout after processing, or an unverifiable
    // response). REFUND_SALE carries no idempotency key, so rolling the reservation
    // back and inviting a retry ("try again") would DOUBLE-REFUND the customer.
    // Instead keep the reservation (a retry is blocked by refundBoundsError since
    // the row is no longer paid/partially_refunded), freeze the row as needs_review
    // (terminal — the reconcile cron won't re-alert), and send the operator to the
    // MMS. Mirrors the settle amount-mismatch hold. If the money did NOT move, a
    // human clears the hold and re-issues; if it did, the reservation is already
    // correct.
    const message = err instanceof Error ? err.message : "Gateway unreachable";
    await sb
      .from("card_payments")
      .update({
        status: "needs_review",
        response_message: `REFUND UNCONFIRMED — verify in takepayments MMS: ${message}`.slice(0, 512),
      })
      .eq("id", row.id);
    await sb.from("events_log").insert({
      actor_id: input.actorId,
      entity_type: "card_payment",
      entity_id: row.id,
      action: "refund_unconfirmed",
      diff: { amount_pence: amount, reason, error: message } as never,
    } as never);
    await sendOpsAlert(
      `Card refund UNCONFIRMED — attempt ${row.id.slice(0, 8)}`,
      [
        `A refund of <strong>£${(amount / 100).toFixed(2)}</strong> was sent to takepayments for quote ${row.quote_id}, but the gateway did not confirm (${message}).`,
        `It MAY have gone through. Check the takepayments MMS for this transaction. The attempt is flagged <strong>needs review</strong> — do NOT retry the refund in the app until you have confirmed, as a blind retry can refund the customer twice.`,
      ],
      "money",
    );
    return {
      ok: false,
      error:
        "The refund was sent but the gateway didn't confirm — it may have gone through. Check the takepayments MMS for this transaction before retrying. This payment is flagged for review.",
    };
  }

  // Gateway succeeded — finalise status + audit (refunded_pence already reserved).
  const now = new Date().toISOString();
  await sb
    .from("card_payments")
    .update({
      status: voided ? "voided" : reservedPence >= row.amount_pence ? "refunded" : "partially_refunded",
      refund_reason: reason.slice(0, 512),
      refunded_by: input.actorId,
      refunded_at: now,
    })
    .eq("id", row.id);

  const quote = await fetchQuoteById(sb, row.quote_id);
  const label = `£${(amount / 100).toFixed(2)}`;
  if (row.lead_id) {
    // The double-payment task asked "decide which payment to refund". Issuing
    // the refund IS that decision, and nothing closed it — neither this module
    // nor app/actions/refunds.ts touched follow_ups — so the card that sent the
    // operator here stayed open on the board forever, still asking.
    // Scoped to the double-payment task only. The credit-note reminder shares
    // this reason+source but is raised LATER in this same refund (the VAT
    // reversal runs after), so an unscoped close would either miss it or, worse,
    // retire an accounting job the moment it was created.
    const { error: taskError } = await sb
      .from("follow_ups")
      .update({ status: "done", outcome: "reached" })
      .eq("lead_id", row.lead_id)
      .eq("reason", "custom")
      .eq("source", "card_payment")
      .eq("status", "open")
      .neq("metadata->>kind", "credit_note");
    if (taskError) {
      log.warn("card.refund.double_payment_task_close_failed", { cardPaymentId: row.id, error: taskError.message });
    }

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

  // Automated VAT reversal: this refund/void returned real money, so the output
  // VAT on the deposit is reversed by raising + refunding a Zoho credit note, then
  // emailing accounts@ to verify. Falls back to a tracked manual reminder if Zoho
  // fails; never throws (the gateway already moved the money).
  //
  // NEVER for a test row: settleCardPayment skips the whole Zoho/customer pipeline
  // for is_test (so a test deposit has NO Zoho invoice to reverse), and posting a
  // real credit note for it would corrupt the LIVE VAT return. Mirror that guard.
  if (!row.is_test) {
    await reverseDepositVatInZoho(sb, {
      quoteId: row.quote_id,
      quoteRef: quote?.quote_ref ?? null,
      zohoContactId: quote?.zoho_contact_id ?? null,
      zohoDepositInvoiceId: quote?.zoho_deposit_invoice_id ?? null,
      depositInvoiceProvider: quote?.deposit_invoice_provider ?? null,
      contactProvider: quote?.contact_provider ?? null,
      zohoDepositInvoiceNumber: quote?.zoho_deposit_invoice_number ?? null,
      customerName: quote?.customer_name ?? null,
      customerEmail: quote?.customer_email ?? null,
      leadId: row.lead_id,
      clientId: row.client_id,
      amountPence: amount,
      mode: "creditcard",
      voided,
      idemKey: `${row.id}-${reservedPence}`,
      onCreditNote: async (creditNoteId, creditNoteNumber) => {
        await sb
          .from("card_payments")
          // Stamp WHICH ledger raised the note (0109) — refundCreditNote is
          // called against this id later, and after the cutover a note raised
          // in the old system would otherwise be looked up in the new one.
          .update({
            zoho_credit_note_id: creditNoteId,
            credit_note_provider: configuredProvider(),
            zoho_credit_note_number: creditNoteNumber,
          } as never)
          .eq("id", row.id);
      },
    });
  }

  // Customer note — duplicate-guarded like every other send. A same-day VOID
  // cancels the pending authorisation (no credit lands on a statement), so the
  // copy must differ from a settled refund or the customer waits for a line
  // that never arrives.
  if (quote?.customer_email) {
    // ONE brand resolve per send (multi-brand PRD §3.5); marley = today.
    const brand = await getBrandOrDefault(sb, quote.brand);
    const isDefaultBrand = brand.slug === DEFAULT_BRAND;
    const brandName = isDefaultBrand ? "Marley Moves" : brand.name;
    const brandPhone = isDefaultBrand ? "01747 637070" : (brand.phone ?? "01747 637070");
    const firstName = (quote.customer_name ?? "").trim().split(/\s+/)[0] || undefined;
    const endsLine = row.card_number_mask ? ` ending ${row.card_number_mask.slice(-4)}` : "";
    const bodyPara = voided
      ? `We've cancelled the ${label} card payment${endsLine} — it was never taken, so there's nothing further you need to do. If it showed as pending on your statement, that will simply drop off.`
      : `We've refunded ${label} to your card${endsLine}. It normally appears on your statement within 3–5 working days.`;
    await dispatchComm(sb, input.actorId, {
      channel: "email",
      // Money desk identity (docs/email-identity-plan.md) — refund questions
      // go back to accounts, like every other money email.
      from: accountsFromFor(brand),
      replyTo: accountsAddress(),
      to: quote.customer_email,
      subject: voided
        ? `Your ${label} card payment has been cancelled (${quote.quote_ref})`
        : `Your ${label} refund from ${brandName} (${quote.quote_ref})`,
      bodyText: `${bodyPara} Any questions, call us on ${brandPhone}.`,
      bodyHtml: brandedEmailHtml({
        preheader: voided ? `${label} card payment cancelled` : `${label} refunded to your card`,
        greeting: firstName,
        headline: voided ? "Your payment has been cancelled" : "Your refund is on its way",
        paragraphs: [bodyPara, `Any questions at all, just reply to this email or call us on ${brandPhone}.`],
        brand,
      }),
      brand,
      leadId: row.lead_id ?? undefined,
      quoteId: row.quote_id,
      clientId: row.client_id ?? undefined,
    });
  }

  return { ok: true, refundedPence: amount };
}

/* ------------------------------------------------------------- reconcile */

/** Minutes a pending attempt may sit before we escalate it to a human. Well
 *  past the seconds-level settle window (a real callback/return lands almost
 *  immediately), early enough to catch before the daily deposit chase could
 *  email a customer who has actually already paid. */
export const STUCK_PENDING_ALERT_MIN = 45;

/**
 * Pure decision: should the reconcile cron escalate this attempt to a human?
 * True for a real (non-test) attempt that is still un-settled — `pending` OR
 * `abandoned` — past the threshold and not yet escalated. Extracted so the
 * money-critical condition is unit-tested without the DB/gateway around it.
 *
 * Why `abandoned` counts too: a superseded attempt (retired when the customer
 * started a second one) may still have had its ORIGINAL gateway session
 * completed and charged. With no xref and both channels lost it is exactly as
 * un-queryable as a stuck `pending` one, so it needs the same human MMS check —
 * omitting it left a real (if rare) two-tab hole where a charged customer was
 * never surfaced.
 *
 * Why escalate rather than resolve: the gateway QUERY polls by `xref`, and an
 * attempt whose callback AND browser-return both failed never received one, so
 * it CANNOT be queried. We then can't tell a genuinely abandoned checkout (no
 * charge) from a paid-but-lost transaction — only the takepayments MMS can, by
 * our reference. Escalating (never silently concluding "not paid") is the floor.
 */
export function shouldEscalateStuckPayment(
  row: { status: string; is_test: boolean; created_at: string; reconcile_alerted_at: string | null },
  opts: { nowMs: number; thresholdMin?: number },
): boolean {
  if (!["pending", "abandoned"].includes(row.status)) return false;
  if (row.is_test || row.reconcile_alerted_at) return false;
  const ageMs = opts.nowMs - new Date(row.created_at).getTime();
  return ageMs >= (opts.thresholdMin ?? STUCK_PENDING_ALERT_MIN) * 60 * 1000;
}

/**
 * Safety net, three jobs:
 *  1. Pending/abandoned attempts that carry an `xref` (rare — an attempt that
 *     was settled once then reopened): QUERY the gateway by that xref and
 *     re-settle. A pending OR abandoned attempt with NO xref cannot be queried
 *     (the gateway needs the xref), so instead it is ESCALATED once to a human
 *     to check the takepayments MMS — the customer may have been charged — and a
 *     stuck `pending` one is only swept to `abandoned` after 24 h, after that
 *     escalation, never silently.
 *  2. (folded into 1 via the xref-present branch: a two-tab second charge whose
 *     callback we missed is settled if it carries an xref.)
 *  3. Re-drive `paid` rows whose quote deposit never got confirmed — the crash
 *     window where the card claim committed but the paid pipeline threw. Idempotent.
 */
export async function reconcileCardPayments(
  sb: Sb,
): Promise<{ checked: number; settled: number; abandoned: number; recovered: number; escalated: number }> {
  const config = getTakepaymentsConfig();
  const out = { checked: 0, settled: 0, abandoned: 0, recovered: 0, escalated: 0 };
  if (!config) return out;

  const nowMs = Date.now();
  const tenMinAgo = new Date(nowMs - 10 * 60 * 1000).toISOString();
  const dayAgoMs = nowMs - 24 * 60 * 60 * 1000;
  // Fetch a WIDER window than the 24 h abandon threshold, or the sweep below
  // (created_at < dayAgoMs) could never see the rows it targets — a lower bound
  // of dayAgoMs and a `< dayAgoMs` check are mutually exclusive, which made the
  // sweep dead code. Oldest-first + the 25-row cap means the most-stuck attempt
  // is always processed, never starved out of its escalation under a backlog.
  const windowStart = new Date(nowMs - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data: rows } = await sb
    .from("card_payments")
    .select("*")
    .in("status", ["pending", "abandoned"])
    .lt("created_at", tenMinAgo)
    .gt("created_at", windowStart)
    .order("created_at", { ascending: true })
    .limit(25);

  for (const row of rows ?? []) {
    out.checked++;

    // (1) An attempt that carries an xref CAN be polled — settle from the
    // gateway's answer. (Almost never a pending/abandoned row, but correct.)
    if (row.gateway_xref) {
      let fields: GatewayResponse | null = null;
      try {
        fields = await directRequest(config, { action: "QUERY", xref: row.gateway_xref });
      } catch {
        continue; // transport blip — next run retries
      }
      const found = Number(fields.responseCode) === RC_SUCCESS || fields.xref;
      if (found && fields.transactionUnique === row.id) {
        const outcome = await settleCardPayment(sb, fields);
        if (outcome.ok && outcome.state === "paid") out.settled++;
      }
      continue;
    }

    // No xref → un-queryable. Escalate once so a human verifies in the MMS
    // BEFORE anything ever treats this as unpaid; only then let it age out.
    // Covers `abandoned` (superseded) rows too — their original session may
    // still have been charged.
    if (shouldEscalateStuckPayment(row, { nowMs })) {
      const { data: q } = await sb.from("quotes").select("quote_ref").eq("id", row.quote_id).maybeSingle();
      const ref = q?.quote_ref ?? row.quote_id?.slice(0, 8) ?? "?";
      await sendOpsAlert(
        "Card payment unconfirmed — verify in takepayments",
        [
          `A card deposit for quote ${ref} has had no confirmation from the gateway for ${STUCK_PENDING_ALERT_MIN}+ minutes.`,
          `The customer MAY have been charged. Check the takepayments MMS for reference ${row.id} (£${(row.amount_pence / 100).toFixed(2)}).`,
          `If it shows there as paid, mark the deposit paid on the quote. If there's no charge, no action is needed — it will clear on its own.`,
        ],
        "money",
      );
      await sb.from("card_payments").update({ reconcile_alerted_at: new Date(nowMs).toISOString() }).eq("id", row.id);
      out.escalated++;
    }

    if (row.status === "pending" && new Date(row.created_at).getTime() < dayAgoMs) {
      await sb
        .from("card_payments")
        .update({ status: "abandoned", response_message: "no confirmation after 24h — flagged for MMS check" })
        .eq("id", row.id)
        .eq("status", "pending");
      out.abandoned++;
    }
  }

  // (3): a `paid` non-test card row whose quote deposit is still unpaid means
  // the pipeline threw after the claim committed. markDepositPaid is idempotent.
  const { data: orphans } = await sb
    .from("card_payments")
    .select("*")
    .eq("status", "paid")
    .eq("is_test", false)
    .lt("settled_at", tenMinAgo)
    .order("settled_at", { ascending: true })
    .limit(25);
  for (const row of orphans ?? []) {
    const { data: q } = await sb
      .from("quotes")
      .select("deposit_paid_at")
      .eq("id", row.quote_id)
      .maybeSingle();
    if (q && !q.deposit_paid_at) {
      await runPaidPipeline(sb, row, row.gateway_xref);
      out.recovered++;
    }
  }
  return out;
}
