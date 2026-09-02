import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseHeld } from "@/lib/refunds/queue-view";

/**
 * `refund_queue.held` is the one place 0109's provider-stamp contract lives as
 * a column COMMENT and nothing else.
 *
 * 0110 backfilled AND CHECK-constrained every sibling — `quotes`,
 * `storage_invoices`, `card_payments` — under one rule: an id with no stamp is
 * Zoho's, because Zoho is the only ledger that existed before the stamp. It
 * names this jsonb nowhere, and no code re-stamps an existing snapshot
 * (`createRefundQueueEntry` supersedes rows, it does not rewrite them). So
 * every open queue row frozen before this deploy holds a real Zoho invoice id
 * with the key simply missing.
 *
 * `lib/ledger/index.ts` spells out the invariant that makes `asProvider(null)`
 * safe — "the database guarantees it: every `*_provider` column carries a
 * CHECK" — and this reader is precisely where that is untrue. Left null, the
 * multi-payment branch of the VAT reversal resolves a Zoho id against the
 * CONFIGURED provider, which after the flip is Xero: it throws into the
 * fail-soft catch AFTER the money has already left the bank, so no credit note
 * is raised and the reversal degrades to a manual reminder.
 */
describe("parseHeld — an unstamped invoice id predates the stamp, so it is Zoho's", () => {
  const entry = (over: Record<string, unknown> = {}) => ({
    rail: "bank_transfer",
    amount: 100,
    at: "2026-07-02T09:00:00Z",
    label: "deposit",
    ...over,
  });

  it("reads a pre-deploy snapshot's unstamped id as zoho, not as 'no override'", () => {
    // Exactly the shape lib/refunds.ts wrote before the stamp existed: no
    // ledger_provider key at all.
    const [held] = parseHeld([entry({ zoho_invoice_id: "zoho-123" })]);
    expect(held.ledger_provider).toBe("zoho");
  });

  it("applies it to every rung of a multi-payment rail, which is the branch that breaks", () => {
    const out = parseHeld([
      entry({ zoho_invoice_id: "zoho-123" }),
      entry({ at: "2026-07-05T09:00:00Z", label: "commitment", zoho_invoice_id: "zoho-456" }),
    ]);
    expect(out.map((h) => h.ledger_provider)).toEqual(["zoho", "zoho"]);
  });

  it("never invents a stamp for an entry that holds no id", () => {
    const [held] = parseHeld([entry()]);
    expect(held.ledger_provider ?? null).toBeNull();
  });

  it("leaves a real stamp exactly as written", () => {
    const out = parseHeld([
      entry({ zoho_invoice_id: "xero-guid-1", ledger_provider: "xero" }),
      entry({ at: "2026-07-05T09:00:00Z", zoho_invoice_id: "zoho-1", ledger_provider: "zoho" }),
    ]);
    expect(out.map((h) => h.ledger_provider)).toEqual(["xero", "zoho"]);
  });

  /**
   * A PRESENT but non-string stamp is a different thing from an absent one:
   * `lib/refunds.ts` copies a CHECK-constrained column, so the current writer
   * cannot produce it. Corruption is not evidence of a provider, and guessing
   * at it is what the malformed-value rule already refuses to do.
   */
  it("still refuses to guess at a malformed stamp", () => {
    const [held] = parseHeld([entry({ zoho_invoice_id: "z-2", ledger_provider: 7 })]);
    expect(held.ledger_provider ?? null).toBeNull();
  });
});

/**
 * The forward half. Nothing in the database can stop a future writer pushing an
 * id onto `held` without its stamp — the contract is a comment — and the
 * backfill above deliberately reads such an entry as Zoho's, which is right for
 * a pre-deploy row and wrong for a new one. So the writer is pinned here
 * instead, the same way the money call sites are pinned in
 * tests/lib/ledger/access.test.ts: counted rather than eyeballed, because the
 * next rung added will sit beside these three and look exactly like them.
 */
describe("the held writer stamps every id it snapshots", () => {
  it("pairs a ledger_provider with every zoho_invoice_id pushed onto held", () => {
    const src = readFileSync(join(__dirname, "../../../lib/refunds.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
    const ids = src.split(/\bzoho_invoice_id:/).length - 1;
    const stamped = src.split(/\bzoho_invoice_id:[\s\S]{0,200}?\bledger_provider:/).length - 1;
    expect(
      stamped,
      `${ids} zoho_invoice_id assignment(s) but only ${stamped} carry ledger_provider. ` +
        `refund_queue.held has no CHECK to catch this — an unstamped id is read as Zoho's, ` +
        `which silently mis-routes a Xero document once the flip has happened.`,
    ).toBe(ids);
  });
});
