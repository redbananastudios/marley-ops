import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Source guard: the date-confirmation email must describe the balance invoice
 * that EXISTS, not the one the ladder would normally still be waiting for.
 *
 * A late booking (PRD §3.10 Addition 2) raises and emails the -BAL invoice at
 * ACCEPTANCE, and `ensureCommitmentInvoice` then refuses to raise a commitment
 * behind it — a commitment after a balance is always a double-bill. So a
 * customer who confirms their date afterwards has `commitmentAmount` 0 for a
 * reason that has nothing to do with there being nothing to pay, and the
 * zero-commitment copy told them "nothing more to pay right now" and that we
 * would "send the final invoice nearer the time" days before the move, over an
 * unpaid invoice already in their inbox. /q read the invoice and got the same
 * state right, so the two surfaces contradicted each other — and the customer
 * likeliest to arrive on move day unpaid is the one told there is nothing to
 * pay (Greig James, MMR015, is what that costs).
 *
 * `sendDateConfirmationEmail` is deep-IO and unexported, so what is locked here
 * is structural (house convention — see tests/lib/quote/small-job-settled-copy.test.ts):
 * the caller reads the real invoice, carries it into the meta, and the old copy
 * survives only behind that read. The rendered copy itself is unit-tested in
 * tests/lib/comms/date-confirm-email.test.ts.
 */
const FLOW = readFileSync(join(process.cwd(), "lib/quote/accept-flow.ts"), "utf8");
const QPAGE = readFileSync(join(process.cwd(), "app/q/[token]/page.tsx"), "utf8");

const at = (haystack: string, needle: string, what: string): number => {
  const i = haystack.indexOf(needle);
  expect(i, `no longer contains ${what}`).toBeGreaterThan(-1);
  return i;
};

const emailBody = (): string => {
  const start = at(FLOW, "async function sendDateConfirmationEmail(", "sendDateConfirmationEmail");
  const end = FLOW.indexOf("export async function", start + 10);
  return FLOW.slice(start, end === -1 ? FLOW.length : end);
};

describe("date-confirmation email — an already-issued balance invoice is read, not assumed away", () => {
  it("derives the issued balance from the invoice itself and carries it into the meta", () => {
    const body = emailBody();
    const read = at(body, "zoho_balance_invoice_id", "the balance-invoice read");
    expect(body, "the figure must come from the frozen invoice amount").toContain(
      "balance_invoice_amount",
    );
    const metaStart = at(body, "const meta: DateConfirmationMeta", "the meta construction");
    expect(read, "the invoice must be read BEFORE the meta is built").toBeLessThan(metaStart);
    const metaBlock = body.slice(metaStart, metaStart + 900);
    expect(metaBlock, "the meta must carry the issued balance to the HTML/template rails").toContain(
      "balanceInvoiced",
    );
    expect(metaBlock, "and its number, so the copy names the customer's own document").toContain(
      "balanceInvoiceNumber",
    );
    expect(metaBlock, "and whether it is settled, so we never ask twice").toContain(
      "balanceSettled",
    );
  });

  it("a failed re-read falls back to the row we hold, never to 'no invoice'", () => {
    // fetchQuoteById swallows its error and returns null, so an unguarded read
    // of `fresh` would answer "no balance invoice" for a booking that has one —
    // the silent direction, and the one that puts the wrong copy in front of a
    // customer.
    expect(emailBody()).toContain("const balanceRow = fresh ?? quote;");
  });

  it("the plain-text 'nothing more to pay right now' arm sits behind that read", () => {
    const body = emailBody();
    const gate = at(body, "balanceInvoiced", "the issued-balance verdict");
    const oldCopy = at(
      body,
      "Nothing more to pay right now; the balance is due before move day.",
      "the with-balance zero-commitment sentence (bookings with no invoice yet must keep it)",
    );
    expect(gate, "the verdict must be reachable before the sentence it suppresses").toBeLessThan(
      oldCopy,
    );
    // The issued-invoice arm exists and states the ask rather than deferring it.
    expect(body).toContain("has already been invoiced");
  });
});

describe("the email and /q agree about an issued balance", () => {
  it("both surfaces decide it from the same two columns", () => {
    for (const [name, src, idCheck] of [
      ["sendDateConfirmationEmail", emailBody(), "isRealZohoId(balanceRow.zoho_balance_invoice_id)"],
      ["/q", QPAGE, "isRealZohoId(quote.zoho_balance_invoice_id)"],
    ] as const) {
      expect(src, `${name} must test the invoice id, not a recomputed commitment`).toContain(
        idCheck,
      );
      expect(src, `${name} must take the figure off the invoice`).toContain(
        "balance_invoice_amount",
      );
    }
  });
});
