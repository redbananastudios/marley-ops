import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { mapBrand } from "@/lib/brand";
import { brandForComms } from "@/lib/comms/brand-theme";
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

/* The snake_case rows are exposed as well as the mapped Brands, because
   `brandForComms` reads the brands table through a stubbed client and so needs
   the row shape the database returns. */

const brandRow = (over: Record<string, unknown> = {}) => ({
  slug: "pitmans",
  name: "Pitmans Removals & Storage",
  short_name: "Pitmans",
  group_line: "Part of the Marley Group",
  legal_line: "Pitmans Removals & Storage is a trading name of MarleyMoves Ltd.",
  phone: "01258 858564",
  ...over,
});

const marleyRow = (over: Record<string, unknown> = {}) => ({
  slug: "marley",
  name: "Marley Moves",
  short_name: "Marley",
  group_line: "",
  legal_line: "MarleyMoves Ltd",
  phone: "01747 637070",
  card_payments_enabled: true,
  ...over,
});

const brand = (over: Record<string, unknown>) => mapBrand(brandRow(over));

const marley = (over: Record<string, unknown> = {}) => mapBrand(marleyRow(over));

/**
 * Read-only stub dispatching on TABLE NAME, because `brandForComms` reads two:
 * `brands` (through getBrandOrDefault, then again inside cardPaymentsAvailable)
 * and `business_settings` (the global kill switch). The filter chain is the
 * database's job, so the stub hands back a pre-chosen row per table.
 */
function sbStub(o: { globalCard: boolean; row: Record<string, unknown> }): SupabaseClient {
  const from = (table: string) => {
    const data = table === "business_settings" ? { card_payments_enabled: o.globalCard } : o.row;
    const chain = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: () => Promise.resolve({ data, error: null }),
    };
    return chain;
  };
  return { from } as unknown as SupabaseClient;
}

/** `cardPaymentsAvailable` ANDs the gateway CREDENTIALS in as well, and vitest
 *  loads no env file — so without this every assertion below would come out
 *  false for the wrong reason and the suite would prove nothing. */
const GATEWAY_KEYS = ["TAKEPAYMENTS_MERCHANT_ID", "TAKEPAYMENTS_SIGNATURE_KEY"] as const;
let savedGateway: Record<string, string | undefined> = {};

function withGatewayConfigured() {
  savedGateway = {};
  for (const k of GATEWAY_KEYS) {
    savedGateway[k] = process.env[k];
    process.env[k] = "stub";
  }
}

function restoreGateway() {
  for (const k of GATEWAY_KEYS) {
    const was = savedGateway[k];
    if (was === undefined) delete process.env[k];
    else process.env[k] = was;
  }
}

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

  /**
   * The override still works. What has changed is the claim this test used to
   * carry in its NAME — that it is how a caller conveys "the global kill switch
   * is off". It never was: no caller anywhere in the repo assigned it, so that
   * described an intention rather than a wiring, and the global switch reached
   * `/q` and nothing else. The switch now travels as part of the Brand, via
   * `brandForComms` (see the describe below) — a resolver a caller must go
   * through, which cannot be quietly left unwired the way an optional flag can.
   *
   * Kept, and still asserted, for the narrow case it genuinely covers: one send
   * that should not mention card for a reason no switch expresses.
   */
  it("still lets an explicit override win, though it is not how the kill switch travels", () => {
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

/**
 * The SECOND switch. Card copy is gated on two booleans ANDed (PRD §11.10):
 * the global `business_settings.card_payments_enabled` kill switch and the
 * brand's own column. The tests above cover the brand half. The global half
 * reached `/q` (via `cardPaymentsAvailable`) and reached no email at all,
 * because a Brand row cannot see it and the escape hatch meant to carry it had
 * zero assigning callers.
 *
 * The bad combination that produced: global switch OFF, a non-default brand's
 * own switch ON. Email said "pay by card over the phone"; `/q` rendered no card
 * button. The customer is invited to use a rail that does not exist.
 *
 * `brandForComms` closes it at RESOLUTION rather than at ~15 email builders:
 * both `emailTheme` and `invoicePayClause` already read
 * `brand.cardPaymentsEnabled`, so handing them a Brand carrying the EFFECTIVE
 * flag fixes emails and invoice notes together, and neither function changes.
 */
describe("brandForComms — the global kill switch reaches the copy", () => {
  beforeEach(withGatewayConfigured);
  afterEach(restoreGateway);

  it("drops card copy when the GLOBAL switch is off, even with the brand's own switch on", async () => {
    const sb = sbStub({ globalCard: false, row: brandRow({ card_payments_enabled: true }) });
    const resolved = await brandForComms(sb, "pitmans");

    expect(resolved.cardPaymentsEnabled).toBe(false);
    const t = emailTheme(resolved);
    expect(t.cardPhone).toBe(false);
    expect(t.payMethodsText).not.toMatch(/card/i);
    expect(t.payMethodsLine).not.toMatch(/card/i);
    // Everything else still comes from the row — this narrows the card
    // wording, it does not degrade the brand to the default.
    expect(t.name).toBe("Pitmans Removals & Storage");
    expect(t.phone).toBe("01258 858564");
  });

  it("drops the card mention from the invoice note but KEEPS the legal disclosure", async () => {
    const sb = sbStub({ globalCard: false, row: brandRow({ card_payments_enabled: true }) });
    const resolved = await brandForComms(sb, "pitmans");

    const clause = invoicePayClause(resolved, "PMR034", "Payable by");
    expect(clause).not.toMatch(/card/i);
    // The two facts stay independent: the card mention follows the switches,
    // the MarleyMoves Ltd disclosure follows the brand's identity, and dropping
    // the first must never drop the second — the customer is paying into an
    // account whose name does not match the brand on the invoice.
    expect(clause).toContain("part of MarleyMoves Ltd");
    expect(clause).toContain("MARLEYMOVES LTD account");
    expect(clause).toContain("reference PMR034");
  });

  /**
   * The control that makes the two tests above mean something. `cardPaymentsAvailable`
   * ANDs three things, so a false can be a false for the wrong reason — missing
   * gateway credentials rather than the switch under test. If this one fails,
   * the whole describe is proving nothing.
   */
  it("keeps card copy when BOTH switches are on", async () => {
    const sb = sbStub({ globalCard: true, row: brandRow({ card_payments_enabled: true }) });
    const resolved = await brandForComms(sb, "pitmans");

    expect(resolved.cardPaymentsEnabled).toBe(true);
    expect(emailTheme(resolved).payMethodsText).toContain("by card over the phone on 01258 858564");
    const clause = invoicePayClause(resolved, "PMR034", "Payable by");
    expect(clause).toContain("by card over the phone on 01258 858564");
    expect(clause).toContain("part of MarleyMoves Ltd");
  });

  it("still respects the brand half — global on, brand off means no card", async () => {
    const sb = sbStub({ globalCard: true, row: brandRow({ card_payments_enabled: false }) });
    const resolved = await brandForComms(sb, "pitmans");

    expect(resolved.cardPaymentsEnabled).toBe(false);
    expect(emailTheme(resolved).payMethodsText).not.toMatch(/card/i);
  });

  /**
   * The behaviour change to be aware of when reading a deploy: the gateway
   * CREDENTIALS are the third clause, so an environment without them words a
   * non-default brand's copy as bank-only however both switches are set. That
   * is the correct bias (never advertise a rail that cannot take money) but it
   * means an env-var omission is now visible in customer copy, not just on /q.
   */
  it("drops card copy when the gateway is not configured at all", async () => {
    for (const k of GATEWAY_KEYS) delete process.env[k];
    const sb = sbStub({ globalCard: true, row: brandRow({ card_payments_enabled: true }) });
    const resolved = await brandForComms(sb, "pitmans");

    expect(resolved.cardPaymentsEnabled).toBe(false);
    expect(emailTheme(resolved).payMethodsText).not.toMatch(/card/i);
  });

  /**
   * The default brand is deliberately untouched, and this pins it. `emailTheme`
   * returns its LITERAL theme and `invoicePayClause` short-circuits on the slug,
   * so its copy cannot change here whatever the effective flag says. That
   * remains the open remainder of QA-20260826-07 — closing it means either
   * loosening the byte-lock in `email-brand.test.ts` or hiding the toggle for
   * the default brand, which is a call for Peter, not a test rewrite.
   */
  it("changes nothing for the default brand, kill switch off or not", async () => {
    const sb = sbStub({ globalCard: false, row: marleyRow() });
    const resolved = await brandForComms(sb, "marley");

    expect(emailTheme(resolved)).toEqual(emailTheme());
    expect(invoicePayClause(resolved, "MMR001", "Payable by")).toBe(
      "Payable by bank transfer (reference MMR001), by card over the phone on 01747 637070, or cash.",
    );
  });
});

/**
 * A resolver nothing calls is the same defect in a new shape. The previous fix
 * in this area replaced "an opts flag no caller ever set" with "brand flag ??
 * an opts flag no caller ever sets" — the identical dead control, one level up
 * — and no test noticed, because every test drove the pure functions directly.
 *
 * So these assert the WIRING, by reading the source. A copy path that goes back
 * to `getBrandOrDefault` gets the STORED flag and the hole reopens silently.
 * (`getBrandOrDefault` itself is untouched and still correct for Settings,
 * where an admin must see the value they typed, not the effective one.)
 */
describe("the copy sites are actually wired to brandForComms", () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

  const COPY_SITES = [
    "lib/quote/accept-flow.ts",
    "lib/storage/raise-storage-invoices.ts",
    "lib/comms/review-request.ts",
    "app/(dashboard)/comms-actions.ts",
    "app/actions/send-email.ts",
    "app/actions/booking-change.ts",
    "app/api/cron/chase/route.ts",
    "app/actions/refunds.ts",
    "lib/payments/card-payments.ts",
  ];

  it.each(COPY_SITES)("%s resolves its sending brand through brandForComms", (rel) => {
    const src = read(rel);
    expect(src, `${rel} no longer resolves a sending brand at all`).toContain("brandForComms(");
    expect(src, `${rel} resolves a customer-copy brand with the STORED card flag`).not.toContain(
      "getBrandOrDefault",
    );
  });

  it("both invoice-note sites take the effective flag", () => {
    // The invoice note is the one a customer keeps, and it is built from a
    // separately named resolve in each of the two raise paths (commitment and
    // balance) — so name them explicitly rather than trusting the file-level
    // check above to have covered both.
    const src = read("lib/quote/accept-flow.ts");
    const resolves = src.match(/const notesBrand = await \w+\(/g) ?? [];
    expect(resolves, "the two invoice-note brand resolves moved or were renamed").toHaveLength(2);
    for (const line of resolves) expect(line).toContain("brandForComms");
    expect(src.match(/invoicePayClause\(\s*notesBrand/g) ?? []).toHaveLength(2);
  });

  it("the ONE implementation of the two-switch AND is what the resolver calls", () => {
    // Not a second copy of the rule: a drifting duplicate is how `/q` and the
    // emails disagreed in the first place.
    const src = read("lib/comms/brand-theme.ts");
    expect(src).toContain("cardPaymentsAvailable(sb, brand.slug)");
    expect(src).toContain('from "@/lib/payments/card-availability"');
  });
});
