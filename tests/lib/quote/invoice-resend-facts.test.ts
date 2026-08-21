import { describe, expect, it } from "vitest";

import { canResendInvoiceNow, type AcceptQuoteRow } from "@/lib/quote/accept-flow";

/**
 * The pure guards (tests/lib/payments/*-resend.test.ts) prove the RULE. This
 * proves the FACTS reaching it, which is where a correct rule quietly stops
 * mattering: a wiring that always passed `paidStateUnknown: false`, or read
 * only one of the two places a paid deposit is recorded, would leave every one
 * of those tests green while the office emailed a settled customer.
 *
 * Two facts are load-bearing here and neither is visible from the pure guard:
 *  - a FAILED read answers "could not check", never "unpaid";
 *  - the deposit is paid if EITHER the quote or the lead says so, because
 *    markDepositPaid stamps the quote then patches the lead (a failure there
 *    only raises an ops alert) and the lead payments card can stamp the lead
 *    on its own.
 */

const LEAD = "11111111-1111-4111-8111-111111111111";

const quote = (over: Partial<AcceptQuoteRow> = {}): AcceptQuoteRow =>
  ({
    id: "quote-1",
    quote_ref: "MMR015",
    status: "accepted",
    source: "website",
    standard_comms_at: null,
    lead_id: LEAD,
    client_id: null,
    estimator_id: null,
    customer_name: "Greig James",
    customer_email: "greig@example.com",
    customer_phone: null,
    collect_addr: null,
    dest_addr: null,
    moving_date: "2026-09-01",
    vat_enabled: false,
    grand_total: 1200,
    agreed_price: 1200,
    accepted_at: "2026-08-01T09:00:00.000Z",
    accept_token: "tok",
    accepted_name: "Greig James",
    created_at: "2026-07-30T09:00:00.000Z",
    email_sent_at: null,
    deposit_amount: 100,
    deposit_paid_at: null,
    deposit_paid_method: null,
    deposit_selfreport_at: null,
    declined_at: null,
    zoho_contact_id: "c1",
    zoho_deposit_invoice_id: "inv-dep",
    zoho_deposit_invoice_number: "INV-000241",
    zoho_deposit_invoice_url: null,
    zoho_deposit_error: null,
    zoho_balance_invoice_id: null,
    zoho_balance_invoice_number: null,
    zoho_balance_invoice_url: null,
    balance_invoice_amount: null,
    balance_invoice_created_at: null,
    zoho_commitment_invoice_id: "inv-com",
    zoho_commitment_invoice_number: "INV-000242",
    zoho_commitment_invoice_url: null,
    zoho_commitment_error: null,
    commitment_invoice_amount: 200,
    commitment_invoice_created_at: "2026-08-05T09:00:00.000Z",
    commitment_due_date: "2026-08-25",
    commitment_paid_at: null,
    commitment_paid_method: null,
    commitment_chase_t10_at: null,
    date_releasable_at: null,
    booking_cancelled_at: null,
    ...over,
  }) as AcceptQuoteRow;

/** Minimal Supabase double: one canned answer per table for the single
 *  `.select(...).eq(...).maybeSingle()` read each rail makes. */
type Answer = { data: Record<string, unknown> | null; error: { message: string } | null };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeSb(answers: { leads?: Answer; quotes?: Answer }): any {
  const chain = (answer: Answer) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q: any = {};
    for (const m of ["select", "eq", "limit", "order"]) q[m] = () => q;
    q.maybeSingle = async () => answer;
    return q;
  };
  return {
    from: (table: string) =>
      chain(
        (table === "leads" ? answers.leads : answers.quotes) ?? { data: null, error: null },
      ),
  };
}

describe("canResendInvoiceNow — deposit", () => {
  it("allows the send when neither the quote nor the lead says paid", async () => {
    const sb = fakeSb({ leads: { data: { deposit_paid_at: null }, error: null } });
    expect(await canResendInvoiceNow(sb, quote(), "deposit")).toEqual({ ok: true });
  });

  it("refuses when the LEAD says paid and the quote does not", async () => {
    // The office marked the deposit paid on a lead that had no accepted quote
    // at the time; the quote row still reads unpaid. Either copy is enough.
    const sb = fakeSb({ leads: { data: { deposit_paid_at: "2026-08-10T09:00:00Z" }, error: null } });
    expect(await canResendInvoiceNow(sb, quote(), "deposit")).toEqual({
      ok: false,
      reason: "The deposit is already paid — nothing to send.",
    });
  });

  it("refuses when the QUOTE says paid and the lead patch never landed", async () => {
    const sb = fakeSb({ leads: { data: { deposit_paid_at: null }, error: null } });
    const q = quote({ deposit_paid_at: "2026-08-10T09:00:00Z" });
    expect(await canResendInvoiceNow(sb, q, "deposit")).toEqual({
      ok: false,
      reason: "The deposit is already paid — nothing to send.",
    });
  });

  it("refuses when the lead read FAILS — a failed query is not evidence of unpaid", async () => {
    const sb = fakeSb({ leads: { data: null, error: { message: "connection reset" } } });
    expect(await canResendInvoiceNow(sb, quote(), "deposit")).toEqual({
      ok: false,
      reason: "Could not check whether the deposit is already paid.",
    });
  });

  it("treats a 'pending' invoice claim as no invoice at all", async () => {
    const sb = fakeSb({ leads: { data: { deposit_paid_at: null }, error: null } });
    const q = quote({ zoho_deposit_invoice_id: "pending" });
    expect(await canResendInvoiceNow(sb, q, "deposit")).toEqual({
      ok: false,
      reason: "No deposit invoice has been raised yet — it retries by itself, or raise it in Zoho.",
    });
  });
});

describe("canResendInvoiceNow — commitment", () => {
  it("allows the send when the fresh read confirms it is unpaid", async () => {
    const sb = fakeSb({ quotes: { data: { commitment_paid_at: null }, error: null } });
    expect(await canResendInvoiceNow(sb, quote(), "commitment")).toEqual({ ok: true });
  });

  it("refuses on the FRESH paid state, not the row the caller was holding", async () => {
    // Paid between the page render and the button press — the case a stale row
    // would send straight through.
    const sb = fakeSb({ quotes: { data: { commitment_paid_at: "2026-08-20T09:00:00Z" }, error: null } });
    expect(await canResendInvoiceNow(sb, quote(), "commitment")).toEqual({
      ok: false,
      reason: "The commitment is already paid — nothing to send.",
    });
  });

  it("refuses when the paid read FAILS", async () => {
    const sb = fakeSb({ quotes: { data: null, error: { message: "statement timeout" } } });
    expect(await canResendInvoiceNow(sb, quote(), "commitment")).toEqual({
      ok: false,
      reason: "Could not check whether the commitment is already paid.",
    });
  });

  it("refuses a legacy iMVE booking whose standard comms are still off", async () => {
    const sb = fakeSb({ quotes: { data: { commitment_paid_at: null }, error: null } });
    const q = quote({ source: "imve", standard_comms_at: null });
    expect(await canResendInvoiceNow(sb, q, "commitment")).toEqual({
      ok: false,
      reason: "This is a legacy iMVE booking — turn its standard comms on before emailing them.",
    });
  });

  it("allows a legacy booking once the office has switched its comms on", async () => {
    const sb = fakeSb({ quotes: { data: { commitment_paid_at: null }, error: null } });
    const q = quote({ source: "imve", standard_comms_at: "2026-08-19T09:00:00Z" });
    expect(await canResendInvoiceNow(sb, q, "commitment")).toEqual({ ok: true });
  });

  it("refuses a cancelled booking", async () => {
    const sb = fakeSb({ quotes: { data: { commitment_paid_at: null }, error: null } });
    const q = quote({ booking_cancelled_at: "2026-08-18T09:00:00Z" });
    expect(await canResendInvoiceNow(sb, q, "commitment")).toEqual({
      ok: false,
      reason: "This booking was cancelled — its commitment invoice will not be sent again.",
    });
  });
});
