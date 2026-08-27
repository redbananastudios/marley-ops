import { describe, expect, it } from "vitest";

import { mapBrand } from "@/lib/brand";
import { emailTheme } from "@/lib/comms/email-brand";
import { invoicePayClause } from "@/lib/quote/accept-flow";

/**
 * QA-20260826-07: `brands.card_payments_enabled` was a dead control. It was
 * admin-editable in Settings and persisted, and read by neither the copy that
 * claimed to be gated on it nor the code that gated the card channel — so the
 * toggle and the live behaviour could disagree in both directions, and flipping
 * it changed nothing.
 *
 * That matters most at the Pitmans launch, whose whole payment posture is "card
 * off, bank transfer only" resting on a switch that did nothing.
 *
 * These tests pin the two facts that were conflated: whether the card channel
 * is live (the brand's own switch) and whether this is the default brand (which
 * decides the MarleyMoves Ltd disclosure). They are independent.
 */

const brand = (over: Record<string, unknown>) =>
  mapBrand({
    slug: "pitmans",
    name: "Pitmans Removals & Storage",
    short_name: "Pitmans",
    group_line: "Part of the Marley Group",
    legal_line: "Pitmans Removals & Storage is a trading name of MarleyMoves Ltd.",
    phone: "01258 858564",
    ...over,
  });

const marley = (over: Record<string, unknown> = {}) =>
  mapBrand({
    slug: "marley",
    name: "Marley Moves",
    short_name: "Marley",
    group_line: "",
    legal_line: "MarleyMoves Ltd",
    phone: "01747 637070",
    card_payments_enabled: true,
    ...over,
  });

describe("emailTheme — the card switch drives the copy", () => {
  it("names card for a brand whose switch is ON", () => {
    const t = emailTheme(brand({ card_payments_enabled: true }));
    expect(t.cardPhone).toBe(true);
    expect(t.payMethodsText).toContain("by card over the phone on 01258 858564");
    expect(t.payMethodsLine).toContain("card over the phone");
  });

  /** The Pitmans launch posture, and the one the finding says was unreachable. */
  it("never names card for a brand whose switch is OFF", () => {
    const t = emailTheme(brand({ card_payments_enabled: false }));
    expect(t.cardPhone).toBe(false);
    expect(t.payMethodsText).not.toMatch(/card/i);
    expect(t.payMethodsLine).not.toMatch(/card/i);
  });

  /**
   * The bug, stated directly: before the fix this returned false regardless,
   * because nothing read the column.
   */
  it("changes when the switch changes — the control is not inert", () => {
    const on = emailTheme(brand({ card_payments_enabled: true }));
    const off = emailTheme(brand({ card_payments_enabled: false }));
    expect(on.payMethodsText).not.toBe(off.payMethodsText);
    expect(on.payMethodsLine).not.toBe(off.payMethodsLine);
  });

  it("lets an explicit override win, for a caller that knows the global switch is off", () => {
    expect(emailTheme(brand({ card_payments_enabled: true }), { cardPhone: false }).cardPhone).toBe(false);
    expect(emailTheme(brand({ card_payments_enabled: false }), { cardPhone: true }).cardPhone).toBe(true);
  });
});

/**
 * The single-brand invariant. Most Marley call sites pass nothing at all, and
 * those must not change by a byte — this fix is not allowed to touch what a
 * live Marley customer reads.
 */
describe("emailTheme — Marley is untouched", () => {
  it("keeps today's literals when no brand is passed", () => {
    const t = emailTheme();
    expect(t.cardPhone).toBe(true);
    expect(t.payMethodsLine).toBe(
      "Bank transfer, card over the phone on 01747 637070, or cash. Whichever suits.",
    );
    expect(t.payMethodsText).toBe(
      "You can pay by bank transfer, by card over the phone on 01747 637070, or in cash if that is easier:",
    );
  });

  it("is identical whether Marley arrives as null or as its own row", () => {
    expect(emailTheme(marley())).toEqual(emailTheme());
  });

  /**
   * Marley's theme is LITERAL and deliberately ignores its own row — the
   * byte-lock in `email-brand.test.ts` is the single-brand invariant, and a
   * stale or unset flag must never edit what a live Marley customer reads.
   * Turning Marley's Settings toggle off therefore changes no copy: a known,
   * smaller remainder of QA-20260826-07, flagged for Peter rather than fixed by
   * quietly reversing that decision.
   */
  it("ignores Marley's own row flag, keeping the literal theme", () => {
    expect(emailTheme(marley({ card_payments_enabled: false }))).toEqual(emailTheme());
  });

  /**
   * The escape hatch that remains: a caller who knows the GLOBAL kill switch is
   * down can still strip the card wording, and only the two pay-methods
   * sentences change — "call Connor" is a support number, not a card rail.
   */
  it("strips card wording on an explicit override, and nothing else", () => {
    const t = emailTheme(undefined, { cardPhone: false });
    expect(t.cardPhone).toBe(false);
    expect(t.payMethodsText).not.toMatch(/card/i);
    expect(t.callText).toBe(emailTheme().callText);
    expect(t.accent).toBe(emailTheme().accent);
  });
});

/**
 * The invoice note is the customer-visible one, and the two strings below are
 * exactly what Marley's live invoices carry today. A byte difference here is a
 * change to a document a real customer is holding.
 */
describe("invoicePayClause — byte-exact for Marley, correct for the rest", () => {
  it("reproduces today's commitment-invoice wording exactly", () => {
    expect(invoicePayClause(marley(), "MMR001", "Payable by")).toBe(
      "Payable by bank transfer (reference MMR001), by card over the phone on 01747 637070, or cash.",
    );
  });

  it("reproduces today's balance-invoice wording exactly", () => {
    expect(
      invoicePayClause(marley(), "MMR001", "Payment in full is due before move day, by"),
    ).toBe(
      "Payment in full is due before move day, by bank transfer (reference MMR001), by card over the phone on 01747 637070, or cash.",
    );
  });

  /** Card off: no comma before "or cash", matching the pre-fix string exactly. */
  it("reproduces the card-off wording exactly, disclosure included", () => {
    expect(invoicePayClause(brand({ card_payments_enabled: false }), "PMR034", "Payable by")).toBe(
      "Payable by bank transfer (reference PMR034) or cash. Pitmans Removals & Storage is part of " +
        "MarleyMoves Ltd, so your payment goes to the MARLEYMOVES LTD account. Please use reference " +
        "PMR034 so we can match it to your booking.",
    );
  });

  /**
   * The combination the old slug-keyed code could not express at all: a
   * non-default brand with card ON needs BOTH the card mention and the
   * MarleyMoves Ltd disclosure.
   */
  it("gives a card-enabled non-default brand both the card mention and the disclosure", () => {
    const clause = invoicePayClause(brand({ card_payments_enabled: true }), "PMR034", "Payable by");
    expect(clause).toContain("by card over the phone on 01258 858564");
    expect(clause).toContain("part of MarleyMoves Ltd");
    // Its OWN number, never Marley's — that number reaches a different office.
    expect(clause).not.toContain("01747 637070");
  });

  it("never puts the MarleyMoves Ltd disclosure on a Marley invoice", () => {
    expect(invoicePayClause(marley(), "MMR001", "Payable by")).not.toContain("part of MarleyMoves Ltd");
  });

  /**
   * Consistent with `emailTheme`: the default brand's wording is literal, so a
   * stale or unset row flag cannot edit a live Marley invoice. Same known
   * remainder, same reason.
   */
  it("keeps Marley's card wording even if its own row flag is off", () => {
    expect(invoicePayClause(marley({ card_payments_enabled: false }), "MMR001", "Payable by")).toBe(
      invoicePayClause(marley(), "MMR001", "Payable by"),
    );
  });
});
