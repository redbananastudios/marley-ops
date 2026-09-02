import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildQuoteEmailHtml, type QuoteEmailMeta } from "@/lib/comms/quote-email";
import { computeQuote, DEFAULT_PRICING } from "@/lib/quote/pricing";
import { defaultQuoteValues } from "@/lib/quote/form-types";
import { pitmans } from "./brand-fixture";

/**
 * QA-20260826-07's quote-email remainder: `offerCard` — the slot that carries
 * the two-switch card verdict (global AND brand, PRD §11.10) into the quote
 * email — had ZERO assigning callers, so `depositStepCopy` fell through to the
 * brand row's OWN switch and the global kill switch never reached the copy.
 * A brand whose Settings toggle was on advertised "pay by card" while the
 * card channel was globally down.
 *
 * Two properties pinned here:
 *  1. FAIL-SAFE default — for a NON-default brand, card copy appears only on
 *     an explicit `offerCard: true`. An unwired future caller under-promises
 *     a rail; it can never advertise one that may be switched off.
 *  2. The live caller (send-quote-dialog) actually passes the verdict, and the
 *     brand it reads it from is resolved through brandForComms (the ANDed
 *     flag), not the stored row.
 */

const b = computeQuote(
  {
    vehicle: "2luton",
    packing: "full",
    sevenFiveT: 0,
    transitVans: 0,
    days: 1,
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

const CARD_COPY = "Pay by card or bank transfer straight after accepting.";
const BANK_COPY = "Pay by bank transfer straight after accepting.";

/** The stored-row bypass shape: the brand's OWN switch says on (an admin
 *  ticked it) while the caller never resolved the global switch. */
const storedCardOn = { ...pitmans, cardPaymentsEnabled: true };

const meta: QuoteEmailMeta = {
  quoteRef: "PMR-001",
  acceptUrl: "https://ops.marleymoves.co.uk/q/tok_pit",
  depositAmount: 150,
  brand: storedCardOn,
};

describe("quote email card copy — fail-safe two-switch gate (non-default brand)", () => {
  it("UNSET offerCard never promises card, whatever the stored brand row says", () => {
    const html = buildQuoteEmailHtml(values, b, meta);
    expect(html).not.toContain(CARD_COPY);
    expect(html).toContain(BANK_COPY);
  });

  it("offerCard: false renders the bank-transfer wording", () => {
    const html = buildQuoteEmailHtml(values, b, { ...meta, offerCard: false });
    expect(html).not.toContain(CARD_COPY);
    expect(html).toContain(BANK_COPY);
  });

  it("offerCard: true (the resolved two-switch verdict) renders card copy as today", () => {
    const html = buildQuoteEmailHtml(values, b, { ...meta, offerCard: true });
    expect(html).toContain(CARD_COPY);
  });
});

describe("quote email card copy — marley controls stand", () => {
  const marleyMeta: QuoteEmailMeta = {
    quoteRef: "MMR-001",
    acceptUrl: "https://ops.marleymoves.co.uk/q/tok_mm",
    depositAmount: 100,
  };

  it("marley's literal card copy stands with offerCard unset (today's bytes)", () => {
    const html = buildQuoteEmailHtml(values, b, marleyMeta);
    expect(html).toContain(CARD_COPY);
  });

  it("offerCard: true is byte-identical to unset for marley", () => {
    expect(buildQuoteEmailHtml(values, b, { ...marleyMeta, offerCard: true })).toBe(
      buildQuoteEmailHtml(values, b, marleyMeta),
    );
  });

  it("marley keeps the explicit-false escape hatch (pre-existing behaviour)", () => {
    const html = buildQuoteEmailHtml(values, b, { ...marleyMeta, offerCard: false });
    expect(html).not.toContain(CARD_COPY);
    expect(html).toContain(BANK_COPY);
  });
});

describe("wiring — the one production caller passes the real verdict", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

  it("send-quote-dialog wires offerCard from the brand's effective card flag", () => {
    const src = read("components/quote/send-quote-dialog.tsx");
    expect(src).toMatch(/offerCard:[\s\S]*?cardPaymentsEnabled/);
  });

  it("the quote page resolves the dialog's brand through brandForComms (ANDed flag)", () => {
    const src = read("app/(dashboard)/quotes/[id]/page.tsx");
    expect(src).toContain("brandForComms(sb, quote.brand)");
    expect(src).not.toContain("getBrandOrDefault(sb, quote.brand)");
  });
});
