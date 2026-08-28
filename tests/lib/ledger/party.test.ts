import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { partyForQuote } from "@/lib/ledger/party";

vi.mock("@/lib/log", () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { log } from "@/lib/log";

/**
 * The contact key. Xero enforces a unique ContactName across all active contacts
 * and Zoho does not, so resolving a contact by the customer's NAME — which every
 * call site did before gate 18a — either fails outright for the second
 * "John Smith" or, far worse, adopts the first one's contact and bills a
 * stranger.
 *
 * These tests exist mostly to pin the FALLBACK, because that is where the
 * decision lives and it is the branch nobody will exercise by hand.
 */
describe("partyForQuote", () => {
  afterEach(() => vi.clearAllMocks());

  it("keys on the client when there is one — the real spine", () => {
    // clients.id survives name, email and phone changes, which is exactly the
    // property a contact key needs and a name does not have.
    expect(partyForQuote({ id: "q1", clientId: "c1" })).toEqual({ kind: "client", id: "c1" });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("falls back to the quote id, never to the name", () => {
    expect(partyForQuote({ id: "q1", clientId: null })).toEqual({ kind: "quote", id: "q1" });
  });

  /**
   * The failure directions are not symmetric, and that asymmetry IS the design:
   * a quote key fragments one person into two Xero contacts (visible, human-
   * fixable, never mis-bills), while a name key collapses two people into one
   * (silent, and unrecoverable once the invoice has been sent).
   */
  it("never produces the same key for a client and a quote sharing an id", () => {
    const asClient = partyForQuote({ id: "shared", clientId: "shared" });
    const asQuote = partyForQuote({ id: "shared", clientId: null });
    expect(asClient).not.toEqual(asQuote);
    expect(asClient.kind).toBe("client");
    expect(asQuote.kind).toBe("quote");
  });

  /**
   * Measured on production 2026-08-28: 0 of 116 quotes have a null `client_id`,
   * because the only writer takes it from the lead and `leads.client_id` is NOT
   * NULL. So this branch fires only when something upstream has already broken —
   * which is exactly the kind of branch that must not fire silently.
   */
  it("logs the fallback so a branch that should never fire is countable", () => {
    partyForQuote({ id: "q-orphan", clientId: null });
    expect(log.warn).toHaveBeenCalledWith("ledger.contact.quote_keyed", { quoteId: "q-orphan" });
  });

  it("treats an empty-string client id as absent rather than keying on nothing", () => {
    expect(partyForQuote({ id: "q1", clientId: "" })).toEqual({ kind: "quote", id: "q1" });
  });
});

/**
 * The guard that keeps the whole change honest.
 *
 * `party` is REQUIRED on the seam's `findOrCreateContact` specifically so that a
 * call site added later cannot silently fall through to name-only resolution
 * under Xero. Making it optional would compile everywhere and break nothing
 * until a real duplicate name reached the live books. A source assertion is the
 * only way to pin "required", because the alternative — a type-level test — is
 * exactly what a future edit to the type would take with it.
 */
describe("the seam keeps the contact key mandatory", () => {
  it("declares party as required, not optional, on the adapter interface", () => {
    const src = readFileSync(join(__dirname, "../../../lib/ledger/types.ts"), "utf8");
    expect(src).toMatch(/party:\s*LedgerParty;/);
    expect(
      /party\?:/.test(src),
      "an optional `party` lets a future call site resolve a Xero contact by NAME — the " +
        "collision this field exists to prevent, arriving silently on the money path",
    ).toBe(false);
  });

  it("keeps every money call site keyed, so none can regress to name-only", () => {
    const sites = [
      ["lib/quote/accept-flow.ts", 3],
      ["lib/storage/raise-storage-invoices.ts", 1],
      ["lib/payments/refund-vat.ts", 1],
    ] as const;
    for (const [rel, expected] of sites) {
      const src = readFileSync(join(__dirname, "../../../", rel), "utf8");
      const calls = src.match(/findOrCreateContact\(\{/g) ?? [];
      expect(calls.length, `${rel} call-site count changed — re-check the new one carries a party`).toBe(expected);
      expect(src, `${rel} must pass a party to every findOrCreateContact call`).toMatch(/party[,:]/);
    }
  });
});
