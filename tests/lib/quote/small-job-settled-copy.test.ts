import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Gate 9a small jobs take ONE payment: at or under the small-job threshold the
 * acceptance ask IS the gross, the commitment clamps to 0 and NO balance ever
 * raises. Three surfaces went on describing the ladder anyway:
 *
 *  - `/q`'s post-payment states promised "the balance" and a future final
 *    invoice on a job that has neither — forever, because `balance_paid_at`
 *    never stamps when there is no balance invoice to pay.
 *  - The deposit invoice's document note told the customer "The balance is
 *    invoiced separately before move day."
 *  - The quote page's re-send recomputed the deposit LIVE from today's
 *    settings on an ACCEPTED quote, so a threshold change after acceptance
 *    made the re-sent email contradict the frozen ask and the -DEP invoice.
 *
 * Source guards (house convention for these deep-IO surfaces — see
 * tests/lib/quote/commercial-safety.test.ts): what is locked is structural —
 * each promise sits behind a paid-in-full gate, the old copy survives for
 * jobs that DO carry a balance, and the re-send reads the frozen figure.
 */

const QPAGE = readFileSync(join(process.cwd(), "app/q/[token]/page.tsx"), "utf8");
const QUOTE_PAGE = readFileSync(join(process.cwd(), "app/(dashboard)/quotes/[id]/page.tsx"), "utf8");
const FLOW = readFileSync(join(process.cwd(), "lib/quote/accept-flow.ts"), "utf8");

const at = (haystack: string, needle: string, what: string): number => {
  const i = haystack.indexOf(needle);
  expect(i, `no longer contains ${what}`).toBeGreaterThan(-1);
  return i;
};

describe("/q post-payment states — a paid-in-full small job is told it is settled", () => {
  it("derives paid-in-full from the frozen ask covering the whole job", () => {
    const idx = at(QPAGE, "const paidInFull", "the paidInFull derivation");
    const decl = QPAGE.slice(idx, idx + 200);
    expect(decl).toContain("deposit >= total");
  });

  // JSX rewraps freely, so the copy is matched against a whitespace-flattened
  // view of the file; offsets below index into that view.
  const FLAT = QPAGE.replace(/\s+/g, " ");

  it("the 'final invoice nearer the time' promise sits behind the paid-in-full gate", () => {
    const idx = at(FLAT, "send the final invoice nearer the time", "the deferred-final-invoice promise");
    const before = FLAT.slice(Math.max(0, idx - 700), idx);
    expect(before, "the promise must be reachable only when a balance exists").toContain("paidInFull ?");
    expect(before).toContain("nothing more to pay");
  });

  it("the zero-commitment 'remaining balance is due in full' arm is gated the same way", () => {
    // The fuller needle pins the commitAmt === 0 arm — the only one a small
    // job can reach (its commitment clamps to 0, so the commitment-paid arm's
    // identical promise is unreachable for it and stays as-is).
    const idx = at(
      FLAT,
      "nothing more to pay right now. The remaining balance is due in full before move day.",
      "the zero-commitment balance promise",
    );
    const before = FLAT.slice(Math.max(0, idx - 700), idx);
    expect(before).toContain("paidInFull");
  });
});

describe("quote page re-send — an accepted quote's deposit is the FROZEN one", () => {
  it("reads quote.deposit_amount once accepted, and only recomputes pre-acceptance", () => {
    const idx = at(QUOTE_PAGE, "depositAmount={", "the depositAmount prop");
    const value = QUOTE_PAGE.slice(idx, idx + 900);
    const frozen = at(value, 'statusStr === "accepted"', "the accepted-state frozen branch");
    const recompute = at(value, "requestedDeposit(", "the live pre-acceptance computation");
    // The frozen read must win BEFORE the live recompute is reached.
    expect(frozen).toBeLessThan(recompute);
    expect(value.slice(frozen, recompute)).toContain("quote.deposit_amount");
  });
});

describe("deposit invoice note — no separate-balance promise when the ask IS the job", () => {
  const depositBody = (): string => {
    const start = at(FLOW, "export async function ensureDepositInvoice(", "ensureDepositInvoice");
    const end = FLOW.indexOf("export async function", start + 10);
    return FLOW.slice(start, end === -1 ? FLOW.length : end);
  };

  it("the note is conditional on the deposit covering the whole job", () => {
    const body = depositBody();
    const gate = at(body, "coversWholeJob", "the paid-in-full note gate");
    const oldNote = at(
      body,
      "The balance is invoiced separately before move day.",
      "the standard-deposit note (jobs WITH a balance must keep it)",
    );
    expect(gate).toBeLessThan(oldNote);
    // The settled arm exists and promises nothing further.
    expect(body).toContain("nothing further will be invoiced");
  });
});
