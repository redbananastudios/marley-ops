import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  findOrCreateContact,
  createInvoice,
  recordInvoicePayment,
  voidAndDeleteInvoice,
  voidAndDeleteCreditNote,
  deletePayment,
  deleteContact,
} from "@/lib/zoho";
import { reverseDepositVatInZoho } from "@/lib/payments/refund-vat";

/**
 * LIVE end-to-end proof of the refund → Zoho VAT reversal automation against the
 * DEMO Zoho org (20117092566). Opt-in only, hard-guarded to Demo — never live.
 *   RUN_ZOHO_E2E=1 COMMS_DRYRUN=true \
 *     npx vitest run tests/integration/refund-vat-zoho.test.ts
 * Proves: contact resolution → credit note create → refund recorded → id stored,
 * plus idempotency (a repeat with the same key never double-refunds).
 */

const RUN = process.env.RUN_ZOHO_E2E === "1";
const DEMO_ORG = "20117092566";
const LEAD_ID = "0339605c-5534-4db0-8dbd-668db5373877";
const CLIENT_ID = "f8b8bd67-a2b5-4547-ac25-2782519a267b";

function loadForSupabase(): void {
  // .env.local for the LOCAL Supabase creds only.
  const txt = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
  for (const line of txt.split(/\r?\n/)) {
    if (/^\s*#/.test(line) || !line.trim()) continue;
    const m = line.match(/^\s*(NEXT_PUBLIC_SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}
function forceZohoDemo(): void {
  // .env.e2e ZOHO_* — OVERWRITE so a live-org env can never leak in.
  const txt = readFileSync(resolve(process.cwd(), ".env.e2e"), "utf8");
  for (const line of txt.split(/\r?\n/)) {
    if (/^\s*#/.test(line) || !line.trim()) continue;
    const m = line.match(/^\s*(ZOHO_[A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function zohoGet(path: string): Promise<any> {
  const tokRes = await fetch(`${process.env.ZOHO_ACCOUNTS_URL || "https://accounts.zoho.eu"}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: process.env.ZOHO_REFRESH_TOKEN!,
      client_id: process.env.ZOHO_CLIENT_ID!,
      client_secret: process.env.ZOHO_CLIENT_SECRET!,
      grant_type: "refresh_token",
    }),
  });
  const tok = (await tokRes.json()).access_token;
  const res = await fetch(`${process.env.ZOHO_API_URL || "https://www.zohoapis.eu"}/invoice/v3${path}`, {
    headers: { Authorization: `Zoho-oauthtoken ${tok}`, "X-com-zoho-invoice-organizationid": process.env.ZOHO_ORG_ID! },
  });
  return res.json();
}

describe.skipIf(!RUN)("refund → Zoho VAT reversal (Demo org, end to end)", () => {
  let sb: SupabaseClient;
  let quoteId = "";
  let contactId = "";
  let invoiceId = "";
  let invoiceNumber = "";
  let paymentId = "";
  let creditNoteId = "";

  beforeAll(async () => {
    loadForSupabase();
    forceZohoDemo();
    if (process.env.ZOHO_ORG_ID !== DEMO_ORG) throw new Error(`SAFETY ABORT: org ${process.env.ZOHO_ORG_ID} != DEMO`);
    expect(process.env.COMMS_DRYRUN, "COMMS_DRYRUN must be true — no real emails").toBe("true");

    sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Demo Zoho fixture: a paid £20 deposit invoice.
    contactId = await findOrCreateContact({ name: "VAT Reversal E2E", email: `vat-e2e-${Date.now()}@example.com` });
    const inv = await createInvoice({ customerId: contactId, reference: `VATE2E-${Date.now()}`, description: "Deposit — VAT E2E", amount: 20 });
    invoiceId = inv.invoiceId;
    invoiceNumber = inv.invoiceNumber;
    paymentId = await recordInvoicePayment({ customerId: contactId, invoiceId, amount: 20, mode: "creditcard" });

    // Local quote pointing at the Demo Zoho fixture.
    const { data, error } = await sb
      .from("quotes")
      .insert({
        quote_ref: `VATE2E-${Date.now()}`,
        lead_id: LEAD_ID,
        client_id: CLIENT_ID,
        status: "accepted",
        customer_name: "VAT Reversal E2E",
        customer_email: "vat-e2e@example.com",
        accept_token: randomUUID(),
        deposit_amount: 20,
        zoho_contact_id: contactId,
        zoho_deposit_invoice_number: invoiceNumber,
      } as never)
      .select("id")
      .single();
    if (error) throw new Error(`quote fixture: ${error.message}`);
    quoteId = (data as { id: string }).id;
  }, 60_000);

  afterAll(async () => {
    if (creditNoteId) await voidAndDeleteCreditNote(creditNoteId).catch(() => {});
    if (paymentId) await deletePayment(paymentId).catch(() => {});
    if (invoiceId) await voidAndDeleteInvoice(invoiceId).catch(() => {});
    if (contactId) await deleteContact(contactId).catch(() => {});
    if (sb && quoteId) {
      await sb.from("follow_ups").delete().eq("quote_id", quoteId);
      await sb.from("quotes").delete().eq("id", quoteId);
    }
  });

  it("raises + refunds a Zoho credit note, stores the id, and is idempotent", async () => {
    const input = {
      quoteId,
      quoteRef: "VATE2E",
      zohoContactId: contactId,
      zohoDepositInvoiceId: invoiceId,
      zohoDepositInvoiceNumber: invoiceNumber,
      customerName: "VAT Reversal E2E",
      customerEmail: "vat-e2e@example.com",
      leadId: LEAD_ID,
      clientId: CLIENT_ID,
      amountPence: 2000,
      mode: "creditcard" as const,
      voided: false,
      idemKey: "e2e-1",
    };

    let stored: { id: string; number: string } | null = null;
    const first = await reverseDepositVatInZoho(sb, {
      ...input,
      onCreditNote: async (id, number) => {
        stored = { id, number };
      },
    });
    expect(first.ok, `first reversal: ${JSON.stringify(first)}`).toBe(true);
    expect(first.fellBack).toBe(false);
    expect(first.creditNoteNumber).toBeTruthy();
    expect(stored).not.toBeNull();
    creditNoteId = stored!.id;

    // Verify in Demo Zoho: the credit note exists and its FULL £20 was refunded.
    const cn = await zohoGet(`/creditnotes/${creditNoteId}`);
    expect(Number(cn.creditnote?.total)).toBe(20);
    expect(Number(cn.creditnote?.total_refunded_amount)).toBe(20);

    // Idempotency: a repeat with the SAME idemKey adopts the same note and never
    // double-refunds (the balance guard returns already_refunded).
    const again = await reverseDepositVatInZoho(sb, { ...input, onCreditNote: async () => {} });
    expect(again.ok).toBe(true);
    expect(again.fellBack).toBe(false);
    const cn2 = await zohoGet(`/creditnotes/${creditNoteId}`);
    expect(Number(cn2.creditnote?.total_refunded_amount), "no double refund").toBe(20);
  }, 60_000);

  it("falls back to a tracked reminder when Zoho is unreachable, never throwing", async () => {
    // Point Zoho at a bad org so the API errors → must fall back, not throw.
    const savedOrg = process.env.ZOHO_ORG_ID;
    process.env.ZOHO_ORG_ID = "000000000";
    try {
      const res = await reverseDepositVatInZoho(sb, {
        quoteId,
        quoteRef: "VATE2E",
        zohoContactId: null,
        zohoDepositInvoiceId: invoiceId,
        zohoDepositInvoiceNumber: invoiceNumber,
        customerName: "VAT Reversal E2E",
        customerEmail: "vat-e2e@example.com",
        leadId: LEAD_ID,
        clientId: CLIENT_ID,
        amountPence: 2000,
        mode: "creditcard",
        voided: false,
        idemKey: "e2e-fallback",
      });
      expect(res.ok).toBe(false);
      expect(res.fellBack).toBe(true);
      const { data: fups } = await sb.from("follow_ups").select("notes").eq("quote_id", quoteId).eq("source", "card_payment");
      expect((fups ?? []).some((f) => /credit note/i.test((f.notes as string | null) ?? "")), "fallback follow-up raised").toBe(true);
    } finally {
      process.env.ZOHO_ORG_ID = savedOrg;
    }
  }, 60_000);
});
