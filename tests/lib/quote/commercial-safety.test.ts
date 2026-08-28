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
