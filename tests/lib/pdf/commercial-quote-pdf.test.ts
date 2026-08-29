import { describe, expect, it } from "vitest";
import { computeQuote, DEFAULT_PRICING } from "@/lib/quote/pricing";
import { defaultQuoteValues } from "@/lib/quote/form-types";
import { buildQuoteDocDef } from "@/lib/quote/pdf-client";

/**
 * The quote PDF a COMMERCIAL customer receives (PRD §3.10, gate 10b).
 *
 * QA-20260828-03 found `/q` rendering the residential accept screen — deposit
 * figure, payment copy, enabled Accept button — at a commercial client. The
 * server refused the click, so no money was at risk, but the same defect lives
 * in the attached PDF and is worse there: a PDF reaches the customer whether or
 * not they ever open the link, it is the artefact they keep and forward to
 * their accounts department, and nothing about it can be corrected after it is
 * sent. It asked for a "£100 deposit" in three separate places — the acceptance
 * strip, the terms clause, the acceptance declaration — and printed a QR code
 * pointing at a page that turns the customer away.
 *
 * The £100 is not a stored figure either. A commercial quote's `deposit_amount`
 * is 0 by design, and the doc-def's `> 0 ? … : 100` fallback turned that into
 * the residential default, so the document invented an obligation that exists
 * nowhere in the database.
 *
 * The scan below is deliberately the WHOLE document rather than the three known
 * sites: three separate places is exactly what a narrow assertion misses.
 */

/** pdfmake doc-defs carry closures (footer, layout colours). Invoke each so the
 *  scan covers what they would render — a deposit line moved into a footer
 *  closure would otherwise pass a plain JSON.stringify. Mirrors the helper in
 *  gate14-brand-spec.test.ts. */
function resolveFns(node: unknown): unknown {
  if (typeof node === "function") {
    const fn = node as (...args: unknown[]) => unknown;
    try {
      return { fnResult: resolveFns(fn(1, 2)) };
    } catch {
      try {
        return { fnResult: resolveFns(fn(1, { table: { body: [] } })) };
      } catch {
        return "fn-threw";
      }
    }
  }
  if (Array.isArray(node)) return node.map(resolveFns);
  if (node && typeof node === "object") {
    return Object.fromEntries(
      Object.entries(node as Record<string, unknown>).map(([k, v]) => [k, resolveFns(v)]),
    );
  }
  return node;
}
const flatten = (node: unknown): string => JSON.stringify(resolveFns(node));

const b = computeQuote(
  {
    vehicle: "2luton",
    packing: "full",
    sevenFiveT: 0,
    transitVans: 0,
    days: 2,
    deadMiles: 10,
    jobMiles: 10,
    collectAccessM: 0,
    destAccessM: 0,
    collectType: "house",
    collectFloor: "ground",
    destType: "house",
    destFloor: "ground",
    congestion: false,
    tolls: 0,
    parking: 0,
    discount: 0,
    vatEnabled: true,
  },
  DEFAULT_PRICING,
);
const values = defaultQuoteValues();

const ACCEPT_URL = "https://ops.marleymoves.co.uk/q/tok_commercial_probe";
/** A commercial quote as the office actually holds one: deposit_amount 0 — the
 *  value gate 10b WRITES rather than leaving null — and an accept token, because
 *  every quote gets one regardless of policy. */
const meta = {
  quoteRef: "MMC-260828-001",
  vatNumber: "GB 123 4567 89",
  depositAmount: 0,
  acceptUrl: ACCEPT_URL,
};

describe("commercial quote PDF", () => {
  it("residential is untouched — an explicit 'residential' is byte-identical to no policy at all", () => {
    // The guard that lets this change ship at all: every existing call site
    // omits the field, and gate 10b's whole premise is that residential
    // behaviour does not move.
    const absent = resolveFns(buildQuoteDocDef(values, b, meta));
    expect(resolveFns(buildQuoteDocDef(values, b, { ...meta, paymentPolicy: "residential" }))).toEqual(
      absent,
    );
    expect(resolveFns(buildQuoteDocDef(values, b, { ...meta, paymentPolicy: undefined }))).toEqual(absent);
  });

  it("the residential document DOES ask for a deposit — so the commercial scan below is not vacuous", () => {
    // Without this, every assertion in the next test would pass just as well
    // against a document that never mentioned money at all, or against a
    // `flatten` that silently returned "".
    const flat = flatten(buildQuoteDocDef(values, b, { ...meta, depositAmount: 100 }));
    expect(flat.toLowerCase()).toContain("deposit");
    expect(flat).toContain(ACCEPT_URL);
  });

  it("asks a commercial customer for NOTHING up front, anywhere in the document", () => {
    const flat = flatten(buildQuoteDocDef(values, b, { ...meta, paymentPolicy: "commercial" }));
    // The whole document, not the three sites we know about.
    expect(flat.toLowerCase(), "a commercial quote must not print the word deposit").not.toContain(
      "deposit",
    );
    // The £100 the fallback used to invent out of a 0 column.
    expect(flat, "the residential default must not surface as an amount").not.toContain("£100");
  });

  it("carries no route to accept online — no link, and no QR code pointing at one", () => {
    const doc = buildQuoteDocDef(values, b, { ...meta, paymentPolicy: "commercial" });
    const flat = flatten(doc);
    expect(flat, "the accept URL must not appear as a link or as QR content").not.toContain(ACCEPT_URL);
    // The QR is a `{ qr: … }` node, so its absence is structural rather than
    // textual: a QR whose content came from somewhere else would still be a
    // scannable route to a page that refuses this customer.
    expect(flat, "no QR node may survive on a commercial quote").not.toContain('"qr"');
  });

  it("says what DOES happen instead — the customer is not left with silence", () => {
    const flat = flatten(buildQuoteDocDef(values, b, { ...meta, paymentPolicy: "commercial" }));
    // Removing the ask is only half the fix. A commercial customer must be able
    // to read when the invoice comes and what terms it runs on, or the document
    // is merely quiet rather than correct.
    expect(flat).toContain("invoice your account once the move is complete");
    expect(flat).toContain("Nothing is payable up front");
    expect(flat).toContain("payable on the terms agreed with your account");
  });

  it("keeps the signature block, and the terms clause keeps its place in the list", () => {
    const flat = flatten(buildQuoteDocDef(values, b, { ...meta, paymentPolicy: "commercial" }));
    // PRD §3.10 records "no customer-side artefact proving a commercial
    // customer agreed" as an ACCEPTED risk. A signed, returned PDF is the one
    // artefact that answers it, so dropping the block would make that recorded
    // risk worse rather than better.
    expect(flat).toContain("CUSTOMER ACCEPTANCE");
    expect(flat).toContain("By confirming in writing, I accept this quote");
    // Swapped in place, not dropped: the terms list is the same length either
    // way, so the clause cannot silently vanish and leave the document with no
    // payment terms at all.
    const terms = (p?: "commercial") =>
      JSON.stringify(buildQuoteDocDef(values, b, { ...meta, paymentPolicy: p })).match(/"Payment"|"Deposit & payment"/g) ?? [];
    expect(terms("commercial")).toHaveLength(1);
    expect(terms()).toHaveLength(1);
  });
});
