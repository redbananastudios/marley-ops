import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import {
  acceptQuoteOnline,
  confirmMoveDate,
  declineQuoteOnline,
  invoicePayClause,
  settleQuoteInFull,
} from "@/lib/quote/accept-flow";
import { DEFAULT_BRAND } from "@/lib/brand";
import { pitmans } from "../comms/brand-fixture";

/**
 * Every customer-facing ERROR string on the accept flow must speak as the
 * quote's own brand (multi-brand PRD §3.5). The happy paths were brand-resolved
 * in gate 16; the error returns were not — 15 of them hardcoded the default
 * brand's office number, and they render verbatim on /q via accept-form.tsx's
 * `setError(res.error)`. An error state is exactly the moment a customer needs
 * to ring someone, and it handed a Pitmans customer the Marley number.
 *
 * Two halves, matching the house convention for this deep-IO file
 * (tests/lib/quote/commercial-safety.test.ts):
 *
 *  - BEHAVIOURAL: drive the four actions to an error with a stubbed Supabase
 *    client and assert the number that comes out is the brand's own — and that
 *    the default brand's error is BYTE-IDENTICAL to what it said before, so
 *    the fix cannot have reworded the live Marley surface.
 *  - SOURCE GUARDS: the four action bodies contain no hardcoded office number
 *    at all, so a later edit cannot quietly re-introduce one. (The default
 *    number legitimately remains ONLY as the fallback inside the shared
 *    brand-phone pattern, outside these bodies.)
 */

/* ------------------------------------------------------------- stub client */

type Row = Record<string, unknown>;

/** Chainable query stub: every builder method returns the chain, `.eq` records
 *  its filter, and the chain resolves to `{ data }` from the provided lookup —
 *  awaitable directly or via single/maybeSingle. */
function queryStub(resolve: (filters: Row) => unknown) {
  const filters: Row = {};
  const b: Row = {};
  const chain = () => b;
  for (const m of ["select", "limit", "order", "update", "insert", "is", "upsert"]) b[m] = chain;
  b.eq = (col: string, v: unknown) => {
    filters[col] = v;
    return b;
  };
  const result = () => Promise.resolve({ data: resolve(filters) ?? null, error: null });
  b.maybeSingle = result;
  b.single = result;
  b.then = (onFulfilled: (v: unknown) => unknown, onRejected: (e: unknown) => unknown) =>
    result().then(onFulfilled, onRejected);
  return b;
}

/** brands rows as the table stores them (snake_case), keyed by slug. */
const BRAND_ROWS: Record<string, Row> = {
  pitmans: {
    slug: "pitmans",
    name: pitmans.name,
    short_name: pitmans.shortName,
    group_line: pitmans.groupLine,
    legal_line: pitmans.legalLine,
    ref_prefix: pitmans.refPrefix,
    phone: pitmans.phone, // 01258 858564
    card_payments_enabled: false,
    active: true,
    sort_order: 2,
  },
  marley: {
    slug: "marley",
    name: "Marley Moves",
    short_name: "Marley",
    group_line: "",
    legal_line: "MarleyMoves Ltd",
    ref_prefix: "MM",
    phone: "01747 637070",
    card_payments_enabled: true,
    active: true,
    sort_order: 1,
  },
};

function makeSb(quote: Row | null): SupabaseClient<Database> {
  return {
    from(table: string) {
      if (table === "quotes") return queryStub(() => quote);
      if (table === "brands") return queryStub((f) => BRAND_ROWS[String(f.slug)] ?? null);
      return queryStub(() => null);
    },
  } as unknown as SupabaseClient<Database>;
}

const LONG_AGO = "2026-01-01T10:00:00Z"; // > 30 days before any run of this suite

const baseQuote = (brand: string, over: Row = {}): Row => ({
  id: "q-1",
  quote_ref: "PM123",
  status: "sent",
  source: "ops",
  brand,
  payment_policy: null,
  standard_comms_at: null,
  lead_id: null,
  client_id: null,
  customer_name: "Test Customer",
  customer_email: null,
  customer_phone: null,
  moving_date: null,
  vat_enabled: false,
  grand_total: 900,
  agreed_price: null,
  accepted_at: null,
  accept_token: "tok-1234567890",
  accepted_name: null,
  created_at: LONG_AGO,
  email_sent_at: LONG_AGO,
  deposit_amount: null,
  deposit_paid_at: null,
  declined_at: null,
  zoho_deposit_invoice_id: null,
  zoho_balance_invoice_id: null,
  zoho_commitment_invoice_id: null,
  booking_cancelled_at: null,
  ...over,
});

const MARLEY_NUMBER = "01747";

describe("accept-flow error strings resolve the quote's brand (behavioural)", () => {
  it("acceptQuoteOnline: a Pitmans expired quote names the Pitmans number, never Marley's", async () => {
    const res = await acceptQuoteOnline(makeSb(baseQuote("pitmans")), "tok-1234567890", "A Customer", null);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).not.toContain(MARLEY_NUMBER);
    expect(res.error).toContain("01258 858564");
  });

  it("acceptQuoteOnline: the default brand's expired error is BYTE-IDENTICAL to the pre-fix string", async () => {
    const res = await acceptQuoteOnline(makeSb(baseQuote("marley")), "tok-1234567890", "A Customer", null);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("This quote has expired. Call us on 01747 637070 for an updated price.");
  });

  it("declineQuoteOnline: the not-declinable error speaks as the quote's brand", async () => {
    const res = await declineQuoteOnline(
      makeSb(baseQuote("pitmans", { status: "accepted" })),
      "tok-1234567890",
      "other",
    );
    expect(res.ok).toBe(false);
    expect(res.error).not.toContain(MARLEY_NUMBER);
    expect(res.error).toContain("01258 858564");
  });

  it("confirmMoveDate: the cancelled-booking error speaks as the quote's brand", async () => {
    const res = await confirmMoveDate(
      makeSb(
        baseQuote("pitmans", {
          status: "accepted",
          lead_id: "l-1",
          booking_cancelled_at: "2026-08-01T09:00:00Z",
        }),
      ),
      "q-1",
      { signerName: "A Customer", channel: "remote", method: "typed" },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).not.toContain(MARLEY_NUMBER);
    expect(res.error).toContain("01258 858564");
  });

  it("settleQuoteInFull: the not-available error speaks as the quote's brand", async () => {
    const res = await settleQuoteInFull(makeSb(baseQuote("pitmans")), "tok-1234567890", null);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).not.toContain(MARLEY_NUMBER);
    expect(res.error).toContain("01258 858564");
  });
});

/**
 * The blank-phone half of the same rule (2026-09-02).
 *
 * Both customer-facing phone fallbacks in this file resolved the DEFAULT
 * brand's office number for ANY brand, so one Settings save — the Phone field
 * is free text and `optText` maps "" to null — put that number into another
 * brand's own invoice pay clause and its 13 `/q` error strings. The rule
 * lib/comms/templates.ts already states is that the number is the DEFAULT-
 * BRAND fallback ONLY; a named brand with no number degrades to reply-first
 * contact, because a made-up number is worse and a borrowed one is worse still.
 */
describe("a brand with no phone number degrades to reply-first, never to the default number", () => {
  const noPhone = { ...pitmans, phone: null, cardPaymentsEnabled: true };

  it("invoicePayClause drops the card offer rather than naming a number that is not this brand's", () => {
    const clause = invoicePayClause(noPhone, "PMR034", "Payable by");
    expect(clause).not.toContain(MARLEY_NUMBER);
    expect(clause).not.toContain("by card over the phone");
    // Still a complete, payable sentence — the bank rail is the one that works.
    expect(clause).toContain("bank transfer (reference PMR034) or cash.");
  });

  it("a brand WITH a phone and card on still offers the card on its own number", () => {
    const clause = invoicePayClause({ ...pitmans, cardPaymentsEnabled: true }, "PMR034", "Payable by");
    expect(clause).toContain("by card over the phone on 01258 858564");
  });

  it("the default brand's PHONE fallback is unchanged — the fallback belongs to it", () => {
    // cardPaymentsEnabled: true isolates the phone-fallback rule under test
    // from the (now real, 869ett5wy) card-availability rule covered above and
    // in card-toggle.test.ts — this fixture would otherwise exercise both at
    // once and the assertion below couldn't tell which one it was pinning.
    const marleyBrand = { ...pitmans, slug: DEFAULT_BRAND, phone: null, cardPaymentsEnabled: true };
    expect(invoicePayClause(marleyBrand, "MMR001", "Payable by")).toBe(
      "Payable by bank transfer (reference MMR001), by card over the phone on 01747 637070, or cash.",
    );
  });

  it("a phone-less brand's /q error tells the customer to reply, not to ring another company", async () => {
    const quote = baseQuote("pitmans");
    const noPhoneSb = {
      from(table: string) {
        if (table === "quotes") return queryStub(() => quote);
        if (table === "brands") return queryStub(() => ({ ...BRAND_ROWS.pitmans, phone: null }));
        return queryStub(() => null);
      },
    } as unknown as SupabaseClient<Database>;
    const res = await acceptQuoteOnline(noPhoneSb, "tok-1234567890", "A Customer", null);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).not.toContain(MARLEY_NUMBER);
    expect(res.error).toBe("This quote has expired. Reply to your quote email for an updated price.");
  });
});

/* ---------------------------------------------------------- source guards */

const SRC = readFileSync(join(process.cwd(), "lib/quote/accept-flow.ts"), "utf8");

const spanOf = (fn: string): string => {
  const at = SRC.indexOf(`export async function ${fn}(`);
  expect(at, `${fn} not found — rename it here too`).toBeGreaterThan(-1);
  const end = SRC.indexOf("export async function", at + 10);
  return SRC.slice(at, end === -1 ? SRC.length : end);
};

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

describe("accept-flow error strings resolve the quote's brand (source guards)", () => {
  const ACTIONS = ["acceptQuoteOnline", "declineQuoteOnline", "confirmMoveDate", "settleQuoteInFull"] as const;

  it("no customer-facing action body hardcodes the default brand's number", () => {
    for (const fn of ACTIONS) {
      expect(count(spanOf(fn), "01747"), `${fn} still hardcodes the office number`).toBe(0);
    }
  });

  it("every error contact goes through the shared brand resolver", () => {
    for (const fn of ACTIONS) {
      expect(
        count(spanOf(fn), "errorContact(sb, quote.brand)"),
        `${fn} must resolve its error contact from the quote's brand`,
      ).toBeGreaterThan(0);
    }
  });

  it("the default number survives ONLY as the shared fallback pattern", () => {
    // invoicePayClause's documented pattern + the errorPhone helper + the
    // comment that documents the byte-lock. Anything beyond that is a leak the
    // brand-leak scan should also be failing on.
    const bodies = ACTIONS.map(spanOf).join("");
    expect(count(bodies, "01747")).toBe(0);
  });
});
