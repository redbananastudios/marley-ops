import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { directRequest, getTakepaymentsConfig, RC_SUCCESS } from "@/lib/payments/takepayments";
import { refundCardPayment } from "@/lib/payments/card-payments";

/**
 * LIVE end-to-end refund proof against the takepayments SANDBOX gateway.
 * Opt-in only (RUN_SANDBOX_REFUND=1) so it never runs in CI — it hits the real
 * gateway, creates real sandbox transactions, and needs a local Supabase.
 *
 *   RUN_SANDBOX_REFUND=1 COMMS_DRYRUN=true \
 *     npx vitest run tests/integration/card-refund-sandbox.test.ts
 *
 * Proves the parts of refundCardPayment that unit tests can't: the real
 * REFUND_SALE and CANCEL round-trips + signature verify, the atomic
 * reserve/rollback that stops a double-refund, status finalisation, and the
 * audit/email side-effects. Guarded HARD against the live merchant.
 */

const RUN = process.env.RUN_SANDBOX_REFUND === "1";

// Anchor FKs from the seeded local dev DB (service-role bypasses RLS).
const LEAD_ID = "0339605c-5534-4db0-8dbd-668db5373877";
const CLIENT_ID = "f8b8bd67-a2b5-4547-ac25-2782519a267b";
const ACTOR_ID = "7ce6134a-1da4-4e80-9148-50c102bf92be"; // Connor Wass (profiles)

const TEST_CARD = {
  cardNumber: "4929421234600821",
  cardExpiryMonth: 1,
  cardExpiryYear: 28,
  cardCVV: "356",
  customerName: "E2E Refund Test",
  customerAddress: "Flat 6 Primrose Rise 347 Lavender Road",
  customerPostcode: "NN17 8YG",
};

function loadEnvFile(file: string): void {
  let txt = "";
  try {
    txt = readFileSync(resolve(process.cwd(), file), "utf8");
  } catch {
    return;
  }
  for (const line of txt.split(/\r?\n/)) {
    if (/^\s*#/.test(line) || !line.trim()) continue;
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}

describe.skipIf(!RUN)("card refund — live sandbox gateway (end to end)", () => {
  let sb: SupabaseClient;
  let quoteId: string;
  const createdPaymentIds: string[] = [];

  /** Take a real sandbox payment; return the gateway xref + mask. */
  async function takeSandboxPayment(amountPence: number): Promise<{ xref: string; mask: string | null }> {
    const config = getTakepaymentsConfig()!;
    const res = await directRequest(config, {
      action: "SALE",
      type: 1,
      amount: amountPence,
      currencyCode: 826,
      countryCode: 826,
      transactionUnique: randomUUID(),
      orderRef: "E2E-REFUND",
      threeDSRequired: "N",
      ...TEST_CARD,
    });
    expect(Number(res.responseCode), `SALE for ${amountPence}p must authorise`).toBe(RC_SUCCESS);
    expect(res.xref, "SALE must return an xref").toBeTruthy();
    return { xref: res.xref, mask: res.cardNumberMask ?? "492942******0821" };
  }

  /** Insert a settled `paid` card_payments row against the shared test quote. */
  async function makePaidRow(amountPence: number, xref: string, mask: string | null): Promise<string> {
    const { data, error } = await sb
      .from("card_payments")
      .insert({
        quote_id: quoteId,
        lead_id: LEAD_ID,
        client_id: CLIENT_ID,
        kind: "deposit",
        amount_pence: amountPence,
        is_test: false,
        status: "paid",
        gateway_xref: xref,
        settled_at: new Date().toISOString(),
        card_number_mask: mask,
      })
      .select("id")
      .single();
    if (error) throw new Error(`makePaidRow: ${error.message}`);
    createdPaymentIds.push(data.id);
    return data.id;
  }

  async function rowById(id: string) {
    const { data } = await sb.from("card_payments").select("*").eq("id", id).single();
    return data!;
  }

  /** takepayments IP-restricts the Direct-API money-out/management actions
   *  (REFUND_SALE, CANCEL, QUERY). From an unregistered server IP they return
   *  rc 65558 "IP blocked primary". That is an MMS allowlist config, NOT a code
   *  defect, so when we hit it we SKIP (loudly) rather than fail — the scenario
   *  runs its real assertions the moment the calling IP is registered. */
  const isIpBlocked = (r: { ok?: boolean; error?: string }): boolean =>
    r.ok === false && /IP blocked|65558/i.test(r.error ?? "");
  const IP_BLOCK_NOTE =
    "takepayments IP block (rc 65558) — register this host's public IP in the MMS Direct-API allowlist; not a code fault";

  beforeAll(async () => {
    loadEnvFile(".env.local");
    // SAFETY: .env.local's ZOHO_* point at Connor's LIVE org, and refundCardPayment
    // now fires the Zoho reversal. Strip the creds so the reversal takes its
    // fallback path (a tracked follow-up, asserted below) and this test can NEVER
    // touch any Zoho org. The reversal automation is proven separately against the
    // Demo org in refund-vat-zoho.test.ts.
    for (const k of ["ZOHO_CLIENT_ID", "ZOHO_CLIENT_SECRET", "ZOHO_REFRESH_TOKEN", "ZOHO_ORG_ID"]) {
      delete process.env[k];
    }
    const config = getTakepaymentsConfig();
    expect(config, "takepayments config must load from .env.local").toBeTruthy();
    // HARD safety — never the live merchant, never live mode.
    expect(config!.testMode, "TAKEPAYMENTS_TEST_MODE must be true").toBe(true);
    expect(config!.merchantId, "must be SANDBOX merchant 292749, never live 292748").toBe("292749");
    expect(process.env.COMMS_DRYRUN, "COMMS_DRYRUN must be true so no real email sends").toBe("true");

    sb = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );

    // A dedicated quote so the email + audit paths run against real data.
    const { data, error } = await sb
      .from("quotes")
      .insert({
        quote_ref: `E2E-REFUND-${Date.now()}`,
        lead_id: LEAD_ID,
        client_id: CLIENT_ID,
        status: "accepted",
        customer_name: "E2E Refund Test",
        customer_email: "e2e-refund@example.com",
        accept_token: randomUUID(),
        deposit_amount: 20,
      })
      .select("id")
      .single();
    if (error) throw new Error(`quote fixture: ${error.message}`);
    quoteId = data.id;
  });

  afterAll(async () => {
    if (!sb) return;
    for (const id of createdPaymentIds) {
      await sb.from("events_log").delete().eq("entity_type", "card_payment").eq("entity_id", id);
    }
    await sb.from("card_payments").delete().in("id", createdPaymentIds.length ? createdPaymentIds : ["_"]);
    if (quoteId) {
      await sb.from("follow_ups").delete().eq("quote_id", quoteId);
      await sb.from("activities").delete().eq("lead_id", LEAD_ID).ilike("summary", "Card deposit%");
      await sb.from("quotes").delete().eq("id", quoteId);
    }
  });

  it("REFUND_SALE: a partial then the remaining balance → partially_refunded → refunded, with audit rows", async (ctx) => {
    const { xref, mask } = await takeSandboxPayment(2000);
    const id = await makePaidRow(2000, xref, mask);

    // Partial £5 of £20.
    const partial = await refundCardPayment(sb, { paymentId: id, amountPence: 500, reason: "E2E partial", actorId: ACTOR_ID });
    if (isIpBlocked(partial)) return ctx.skip(IP_BLOCK_NOTE);
    expect(partial, `partial refund result: ${JSON.stringify(partial)}`).toEqual({ ok: true, refundedPence: 500 });
    let row = await rowById(id);
    expect(row.status).toBe("partially_refunded");
    expect(row.refunded_pence).toBe(500);
    expect(row.refunded_by).toBe(ACTOR_ID);
    expect(row.refunded_at).toBeTruthy();

    // The audit trail must exist.
    const { data: acts } = await sb.from("activities").select("*").eq("meta->>card_payment_id", id);
    expect((acts ?? []).length, "an activity note is written").toBeGreaterThanOrEqual(1);
    const { data: evs } = await sb.from("events_log").select("*").eq("entity_type", "card_payment").eq("entity_id", id).eq("action", "refunded");
    expect((evs ?? []).length, "an events_log refund entry is written").toBeGreaterThanOrEqual(1);

    // VAT guard-rail: a Zoho credit-note reminder follow-up is raised on the lead.
    const { data: fups } = await sb.from("follow_ups").select("notes").eq("quote_id", quoteId).eq("source", "card_payment");
    expect(
      (fups ?? []).some((f) => /credit note/i.test((f.notes as string | null) ?? "")),
      "a VAT credit-note follow-up is raised on refund",
    ).toBe(true);

    // Remaining £15.
    const rest = await refundCardPayment(sb, { paymentId: id, amountPence: 1500, reason: "E2E remainder", actorId: ACTOR_ID });
    expect(rest, `remainder refund result: ${JSON.stringify(rest)}`).toEqual({ ok: true, refundedPence: 1500 });
    row = await rowById(id);
    expect(row.status).toBe("refunded");
    expect(row.refunded_pence).toBe(2000);
  });

  it("guard: cannot over-refund beyond the remaining balance", async () => {
    const { xref, mask } = await takeSandboxPayment(1000);
    const id = await makePaidRow(1000, xref, mask);
    const bad = await refundCardPayment(sb, { paymentId: id, amountPence: 1500, reason: "too much", actorId: ACTOR_ID });
    expect(bad.ok).toBe(false);
    // No gateway call happened; the row is untouched.
    const row = await rowById(id);
    expect(row.status).toBe("paid");
    expect(row.refunded_pence).toBe(0);
  });

  it("CANCEL/void: a full same-day refund voids the auth (status → voided)", async (ctx) => {
    const { xref, mask } = await takeSandboxPayment(1200);
    const id = await makePaidRow(1200, xref, mask);
    const res = await refundCardPayment(sb, { paymentId: id, amountPence: 1200, reason: "E2E full void", actorId: ACTOR_ID });
    if (isIpBlocked(res)) return ctx.skip(IP_BLOCK_NOTE);
    expect(res, `void result: ${JSON.stringify(res)}`).toEqual({ ok: true, refundedPence: 1200 });
    const row = await rowById(id);
    // Same-day unsettled full refund takes the CANCEL path → voided (no fee);
    // if the sandbox reports the txn already settled it falls through to a
    // REFUND_SALE → refunded. Either is a correct terminal — assert one of them.
    expect(["voided", "refunded"]).toContain(row.status);
    expect(row.refunded_pence).toBe(1200);
    const { data: evs } = await sb.from("events_log").select("action").eq("entity_type", "card_payment").eq("entity_id", id);
    expect((evs ?? []).some((e) => e.action === "voided" || e.action === "refunded")).toBe(true);
  });

  it("double-refund race: two concurrent full refunds → exactly one succeeds, money moves once", async (ctx) => {
    const { xref, mask } = await takeSandboxPayment(800);
    const id = await makePaidRow(800, xref, mask);
    const [a, b] = await Promise.all([
      refundCardPayment(sb, { paymentId: id, amountPence: 800, reason: "race A", actorId: ACTOR_ID }),
      refundCardPayment(sb, { paymentId: id, amountPence: 800, reason: "race B", actorId: ACTOR_ID }),
    ]);
    // The reserve winner reaches the gateway; if THAT call is IP-blocked the
    // race semantics can't be proven live — skip (the DB reserve still ran).
    if (isIpBlocked(a) || isIpBlocked(b)) return ctx.skip(IP_BLOCK_NOTE);
    const wins = [a, b].filter((r) => r.ok).length;
    expect(wins, `exactly one of the two concurrent refunds may succeed (a=${JSON.stringify(a)} b=${JSON.stringify(b)})`).toBe(1);
    const row = await rowById(id);
    expect(row.refunded_pence, "the amount is reserved once, never doubled").toBe(800);
    expect(["voided", "refunded"]).toContain(row.status);
  });

  it("gateway-decline rollback: a refund the gateway rejects leaves the row paid and un-reserved", async (ctx) => {
    // Exhaust the xref out-of-band (a real REFUND_SALE), then present a fresh
    // `paid` row over the same, now-empty xref. Our guard passes (row looks
    // refundable) but the GATEWAY declines → refundCardPayment must roll the
    // optimistic reservation back and surface the decline, never leave the row
    // half-reserved.
    const config = getTakepaymentsConfig()!;
    const { xref, mask } = await takeSandboxPayment(900);
    const drain = await directRequest(config, { action: "REFUND_SALE", xref, amount: 900 });
    // Can't pre-drain without a permitted IP → skip (same MMS allowlist gate).
    if (Number(drain.responseCode) !== RC_SUCCESS) return ctx.skip(IP_BLOCK_NOTE);
    const id = await makePaidRow(900, xref, mask);
    const res = await refundCardPayment(sb, { paymentId: id, amountPence: 900, reason: "E2E rollback", actorId: ACTOR_ID });
    expect(res.ok, `a declined gateway refund must fail: ${JSON.stringify(res)}`).toBe(false);
    const row = await rowById(id);
    expect(row.status, "row stays paid after a declined refund").toBe("paid");
    expect(row.refunded_pence, "reservation rolled back to 0").toBe(0);
  });
});
