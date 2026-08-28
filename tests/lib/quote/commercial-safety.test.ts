import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Gate 10b — the residential money machinery must refuse a COMMERCIAL booking.
 *
 * Both guards here were found by an adversarial pass over the gate 10b plan,
 * not by the plan itself, and both are real: each would have reached a live
 * customer.
 *
 * They are asserted as SOURCE guards rather than behaviour tests because both
 * functions are deep IO — a behaviour test would need the whole ledger and
 * Supabase stack stubbed, and the thing worth protecting is not the arithmetic
 * but the presence and ORDER of two early returns. A future edit that moves
 * either one is exactly what this catches.
 */

const SRC = readFileSync(join(process.cwd(), "lib/quote/accept-flow.ts"), "utf8");

describe("a commercial quote cannot be self-accepted on /q", () => {
  it("acceptQuoteOnline refuses commercial on the SERVER, not just on the page", () => {
    // PRD §3.10: no accept action on /q for commercial — the office confirms it.
    // Hiding the button is not enough: this action is reachable by anyone
    // holding the token, and the row would take status='accepted' with a
    // DEPOSIT invoice raised on the very next line.
    const at = SRC.indexOf("export async function acceptQuoteOnline(");
    const end = SRC.indexOf("export async function", at + 10);
    const body = SRC.slice(at, end);
    expect(body).toContain('if (paymentPolicy === "commercial")');
  });

  it("the refusal happens BEFORE the row is written to accepted", () => {
    const at = SRC.indexOf("export async function acceptQuoteOnline(");
    const end = SRC.indexOf("export async function", at + 10);
    const body = SRC.slice(at, end);
    const refusal = body.indexOf('if (paymentPolicy === "commercial")');
    const write = body.indexOf('status: "accepted"');
    expect(refusal).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(-1);
    // Order is the whole property: refusing after the write would leave an
    // accepted commercial quote behind and merely report failure.
    expect(refusal).toBeLessThan(write);
  });

  it("resolves the refusal from the SAME snapshot the write uses", () => {
    // Re-deriving it separately would let the page and the server disagree
    // about which policy a quote is on — and the shared helper is what carries
    // the unreadable-client logging and the lead fallback.
    const at = SRC.indexOf("export async function acceptQuoteOnline(");
    const end = SRC.indexOf("export async function", at + 10);
    const body = SRC.slice(at, end);
    expect(body).toContain("const paymentPolicy = await snapshotPaymentPolicy(sb, quote);");
    expect(body).not.toMatch(/is_company/);
  });
});

describe("the deposit rung refuses a commercial quote", () => {
  const depositBody = () => {
    const at = SRC.indexOf("export async function ensureDepositInvoice(");
    expect(at, "ensureDepositInvoice not found — rename it here too").toBeGreaterThan(-1);
    const end = SRC.indexOf("export async function", at + 10);
    return SRC.slice(at, end);
  };

  it("returns early for commercial", () => {
    // Commercial has no deposit rung. Without this the function's only gates
    // are status and an existing id — a commercial quote has neither, so it
    // would raise and SEND a real £0 invoice (0 ?? defaultDeposit is 0 under
    // nullish coalescing, and neither ledger adapter refuses a zero line).
    expect(depositBody()).toContain('if (quote.payment_policy === "commercial") return quote;');
  });

  it("refuses BEFORE claiming the creation slot", () => {
    // Claiming first and refusing after would leave zoho_deposit_invoice_id on
    // 'pending' forever, which every other caller reads as "another writer
    // holds this" and backs off from — a booking no code will ever invoice.
    const body = depositBody();
    const guard = body.indexOf('if (quote.payment_policy === "commercial") return quote;');
    const claim = body.indexOf('zoho_deposit_invoice_id: "pending"');
    expect(guard).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(claim);
  });

  it("payment_policy is actually selected, or the guard reads undefined forever", () => {
    // The column is written at acceptance but was never read back. A guard on a
    // field the query does not fetch is `undefined === "commercial"` — always
    // false, silently, on every row.
    expect(SRC).toContain("payment_policy, standard_comms_at");
  });
});

/**
 * The staff path is the ONLY way a commercial quote is accepted (the online one
 * is refused above), and it was residential machinery end to end: it computed a
 * deposit with `requestedDeposit`, wrote it to the row, armed the chase
 * counters, opened a day-5 "deposit still unpaid" call task and emailed the
 * customer the day-1 deposit chase — for a booking with no deposit rung.
 *
 * Source guards for the same reason the two above are: this function is deep IO
 * (Supabase, the ledger, comms dispatch), and what matters is the presence and
 * ORDER of the policy branch, not arithmetic that is unit-tested in
 * tests/lib/payments-policy.test.ts and tests/lib/bookings/commercial-money.test.ts.
 */
describe("the staff accept path takes no deposit on a commercial booking", () => {
  const staffBody = () => {
    const at = SRC.indexOf("export async function acceptQuoteByStaff(");
    expect(at, "acceptQuoteByStaff not found — rename it here too").toBeGreaterThan(-1);
    return SRC.slice(at, SRC.indexOf("/* ---------------", at));
  };

  it("branches the ask on the policy instead of always running requestedDeposit", () => {
    // Unbranched, the residential rule wrote three different wrong figures: the
    // flat default, the inside-T-7 collapse to 25%, and — at or under the
    // small-job threshold — the whole agreed price, which left the only
    // commercial money figure at exactly £0.
    expect(staffBody()).toContain("const deposit = commercial");
  });

  it("resolves the policy BEFORE it computes the ask", () => {
    // Order is the property. The snapshot used to be taken after the deposit
    // was already computed, purely to fill its own column — so nothing the
    // policy knew could reach the figure written beside it.
    const body = staffBody();
    const policy = body.indexOf("const paymentPolicy = await snapshotPaymentPolicy(sb, quote);");
    const ask = body.indexOf("const deposit = commercial");
    expect(policy).toBeGreaterThan(-1);
    expect(ask).toBeGreaterThan(-1);
    expect(policy).toBeLessThan(ask);
  });

  it("never sends the deposit-chase email to a commercial customer", () => {
    // This is the day-1 DEPOSIT CHASE, and it names the figure. Before the fix
    // it asked a business client for money they were never quoted; after it,
    // the same email would ask them for £0. Both reach a real inbox.
    expect(staffBody()).toContain("if (!commercial && quote.customer_email && token)");
  });

  it("never opens a day-5 'deposit still unpaid' call task for one", () => {
    expect(staffBody()).toContain("if (!carriedDeposit && !commercial)");
  });

  it("never arms the deposit chase counters on the lead", () => {
    // deposit_requested_at would date an ask that never happened, and the
    // counters would leave the booking primed for a queue it is excluded from.
    expect(staffBody()).toContain("carriedDeposit || commercial");
  });
});

/**
 * `quotes.commercial_due_date` is read in three places — classifyBooking,
 * owedNow and the /bookings commercial section — and was written by NOTHING.
 * A repo-wide grep returned the migration, the select, the mapping and the two
 * reads. So `pastTerms` was false on every row forever: the overdue state was
 * unreachable, and the internal ops alert the PRD promises could never fire.
 *
 * Peter decided (2026-08-28) that commercial invoices are raised BY HAND on
 * completion, so no automation will ever write it. The office's existing raise
 * IS that moment, which is why it stamps the date rather than a new action
 * doing it — a second step is a second step to forget, and a date recorded
 * apart from the invoice it dates can disagree with it.
 */
describe("the completion invoice dates itself on the client's terms", () => {
  const flowBody = () => {
    const at = SRC.indexOf("export async function createBalanceInvoiceFlow(");
    expect(at, "createBalanceInvoiceFlow not found — rename it here too").toBeGreaterThan(-1);
    return SRC.slice(at, SRC.indexOf("\n/**", at));
  };

  it("stamps commercial_due_date, so something writes the column three call sites trust", () => {
    const body = flowBody();
    expect(body).toContain("commercial_due_date: commercialDueDate");
    expect(body).toContain("paymentTermsDueDate(new Date(), await clientPaymentTermsDays(sb, quote))");
  });

  it("computes the date from the policy snapshot, never from the client's type today", () => {
    // Same reason the policy itself is snapshotted: re-deriving it would let a
    // client edited after the fact re-date an invoice already in their hands.
    expect(flowBody()).toContain('policyOfQuote(quote) === "commercial"');
  });

  it("writes it in the SAME update as the invoice number that makes it readable", () => {
    // All three readers key off zoho_balance_invoice_number. A second write
    // would open a window where the invoice is readable and its terms are not —
    // which is precisely the undated state the classifier now has to alarm on.
    const body = flowBody();
    const number = body.indexOf("zoho_balance_invoice_number: inv.invoiceNumber");
    const due = body.indexOf("commercial_due_date: commercialDueDate");
    expect(number).toBeGreaterThan(-1);
    expect(due).toBeGreaterThan(-1);
    // Same object literal: no `.update(` may open between the two.
    expect(body.slice(number, due)).not.toContain(".update(");
  });

  it("leaves a RESIDENTIAL raise byte-identical", () => {
    // The conditional spread is what guarantees it: residential resolves the
    // date to null and writes no extra key at all.
    expect(flowBody()).toContain("...(commercialDueDate ? { commercial_due_date: commercialDueDate } : {})");
  });
});
