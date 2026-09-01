import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The two surfaces around the completion-invoice email that also spoke
 * residential (PRD §3.10).
 *
 *  1. `sendBalanceInvoiceEmail` composes the subject and the plain-text part
 *     itself, outside the HTML builder, and both hardcoded "due before move
 *     day". `createBalanceInvoiceFlow` already computed a `commercialInvoice`
 *     local for the invoice NOTES twenty lines earlier and never passed it to
 *     the email, so the PDF said one thing and the message carrying it said
 *     another. The office activity note said it too.
 *
 *  2. `/q/[token]` showed an ACCEPTED commercial client a deposit demand. The
 *     only commercial gate on that page covers `status === "sent"`; once staff
 *     mark the job won the status is `accepted` and execution fell past it into
 *     the shared deposit screen, headed "£100 deposit to secure your date"
 *     from the Settings default rather than from the quote. A client on
 *     account terms, revisiting their own link, was asked for money they never
 *     owed.
 *
 * Asserted as SOURCE guards rather than behaviour tests for the same reason
 * commercial-safety.test.ts is: both are deep IO (the whole ledger, Supabase
 * and mail stack) and what is worth protecting is not arithmetic but the
 * presence of a branch and the fact that no arm of it makes the residential
 * claim. The HTML body itself is covered properly, by rendering, in
 * tests/lib/comms/commercial-completion-invoice.test.ts.
 */

const SRC = readFileSync(join(process.cwd(), "lib/quote/accept-flow.ts"), "utf8");
const QPAGE = readFileSync(join(process.cwd(), "app/q/[token]/page.tsx"), "utf8");

/**
 * Comments stripped, so a copy assertion reads what RENDERS rather than what
 * the code says about itself. The blocks below explain the defect they fix and
 * necessarily name the residential rungs while doing it; asserting over that
 * prose would fail on the explanation instead of the copy.
 */
function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/\{\s*\}/g, " ");
}

function bodyOf(src: string, marker: string): string {
  const at = src.indexOf(marker);
  expect(at, `not found: ${marker}`).toBeGreaterThan(-1);
  const end = src.indexOf("\nasync function ", at + 10);
  const end2 = src.indexOf("\nexport async function ", at + 10);
  const stop = Math.min(end === -1 ? src.length : end, end2 === -1 ? src.length : end2);
  return src.slice(at, stop);
}

describe("the completion-invoice email is composed for the right policy", () => {
  const body = () => bodyOf(SRC, "async function sendBalanceInvoiceEmail(");

  it("reads the policy at all", () => {
    // It never did. `grep -n paymentPolicy lib/comms/payment-email.ts` returned
    // nothing, and this function passed no policy in, so the copy could not
    // have branched even if a caller had wanted it to.
    expect(body()).toContain("policyOfQuote(");
  });

  it("neither the subject nor the plain-text part asserts a move-day deadline for commercial", () => {
    const b = stripComments(body());
    // The claim may still be made — but only inside a branch, never as the
    // single unconditional string it was.
    const claim = /due before move day/g;
    for (const m of b.matchAll(claim)) {
      const line = b.slice(b.lastIndexOf("\n", m.index) + 1, b.indexOf("\n", m.index));
      expect(
        /commercial|residential|\?|:/.test(line),
        `unconditional move-day claim: ${line.trim()}`,
      ).toBe(true);
    }
    expect(b).toContain("agreed terms");
  });

  it("passes the terms date through rather than re-deriving it", () => {
    // The date is computed once per raise in createBalanceInvoiceFlow and
    // stamped on the row. Re-deriving it here would let the invoice document
    // and the email covering it fall due on two different days.
    expect(body()).toContain("commercialDueDate");
  });

  it("does not send a commercial invoice through the hosted Resend template", () => {
    // The published template's copy is fixed and residential, so rendering
    // through it would restore in the template exactly the claim the in-repo
    // body has just stopped making. `balanceInvoiceTemplateVars` refuses
    // commercial (locked by rendering in the comms test); this asserts the
    // caller HONOURS that refusal rather than falling back to a truthy id.
    const b = body();
    expect(b).toContain("const templateVars = balanceInvoiceTemplateVars(meta)");
    expect(b).toMatch(/const templateId =[\s\S]{0,160}!templateVars/);
    expect(b).toContain("templateId && templateVars");
  });
});

describe("the raise carries the policy into the email and the activity note", () => {
  const body = () => bodyOf(SRC, "export async function createBalanceInvoiceFlow(");

  it("the office note does not claim a move-day deadline on a commercial job", () => {
    const b = body();
    const at = b.indexOf("Final invoice ${inv.invoiceNumber} raised");
    // Either the summary is now built conditionally, or it no longer makes the
    // claim at all. What it may not be is the unconditional literal it was.
    const around = at === -1 ? "" : b.slice(Math.max(0, at - 400), at + 400);
    expect(at === -1 || /commercial/i.test(around), "unconditional office note").toBe(true);
  });

  it("hands the freshly computed terms date to the email", () => {
    const b = body();
    const at = b.indexOf("sendBalanceInvoiceEmail(");
    expect(at).toBeGreaterThan(-1);
    expect(b.slice(at, at + 400)).toContain("commercialDueDate");
  });
});

describe("the re-send tells the same story as the original", () => {
  const body = () => bodyOf(SRC, "export async function resendBalanceInvoiceFlow(");

  it("passes the stored terms date, so a re-send cannot fall due on a different day", () => {
    const b = body();
    const at = b.indexOf("sendBalanceInvoiceEmail(");
    expect(at).toBeGreaterThan(-1);
    expect(b.slice(at)).toContain("commercialDueDate: quote.commercial_due_date");
  });

  it("the column is actually selected, or the re-send would read undefined", () => {
    // A field absent from QUOTE_COLS reads as undefined on the row, which is
    // indistinguishable from "no terms agreed" and would silently downgrade
    // every re-sent commercial invoice to the dateless copy.
    const at = SRC.indexOf("const QUOTE_COLS");
    expect(SRC.slice(at, SRC.indexOf(";", at))).toContain("commercial_due_date");
  });
});

describe("an accepted commercial quote is not asked for a deposit on /q", () => {
  it("the accepted path gates on the policy, not only the sent path", () => {
    // The `sent` gate is the pre-existing one (QA-20260828-03). It stops
    // covering the page the moment staff mark the job won.
    const sentGate = QPAGE.indexOf('quote.status === "sent" && (await snapshotPaymentPolicy');
    expect(sentGate, "the sent-state gate must still exist").toBeGreaterThan(-1);
    const acceptedGate = QPAGE.indexOf('policyOfQuote(quote) === "commercial"');
    expect(acceptedGate, "the accepted state needs its own gate").toBeGreaterThan(-1);
    expect(acceptedGate).toBeGreaterThan(sentGate);
  });

  it("that gate runs BEFORE the deposit screen's own machinery", () => {
    // Order is the whole property. Falling through to ensureDepositInvoice and
    // the deposit render and only then correcting the copy would still have put
    // a deposit figure in front of the client.
    const acceptedGate = QPAGE.indexOf('policyOfQuote(quote) === "commercial"');
    const ensure = QPAGE.indexOf("await ensureDepositInvoice(sb, quote.id)");
    const depositHeadline = QPAGE.indexOf("deposit to secure your date");
    // Asserted explicitly: without it a missing gate scores -1 and this whole
    // test passes as a comparison of two absences.
    expect(acceptedGate, "the accepted-state gate must exist").toBeGreaterThan(-1);
    expect(ensure).toBeGreaterThan(-1);
    expect(depositHeadline).toBeGreaterThan(-1);
    expect(acceptedGate).toBeLessThan(ensure);
    expect(acceptedGate).toBeLessThan(depositHeadline);
  });

  it("reads the snapshotted policy, not the Settings deposit default", () => {
    // `payment_policy` IS stamped by the time a quote is accepted, by both
    // accept paths — so no extra client lookup is needed or wanted here. The
    // live lookup belongs to the sent state, where the column is still null.
    expect(QPAGE).toContain("policyOfQuote");
  });

  it("the commercial branch says what happens instead, in the established words", () => {
    // Bounded at the residential section marker rather than by a character
    // count, so the window is the branch itself and cannot drift into the
    // deposit screen and fail on ITS copy.
    const at = QPAGE.indexOf('policyOfQuote(quote) === "commercial"');
    const end = QPAGE.indexOf("accepted → pay / done", at);
    expect(end, "the residential section marker must follow the gate").toBeGreaterThan(at);
    const branch = stripComments(QPAGE.slice(at, end));
    expect(branch).toContain("payable on your agreed terms");
    // Nothing in this branch may name a rung a commercial booking does not
    // have, or make the residential deadline claim.
    expect(branch.toLowerCase()).not.toContain("deposit");
    expect(branch.toLowerCase()).not.toContain("commitment");
    expect(branch.toLowerCase()).not.toContain("penalt");
    expect(branch).not.toContain("due before move day");
  });
});
