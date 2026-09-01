import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { balanceRungVisible } from "@/lib/bank-feed/sync";

/**
 * A commercial job's completion invoice must be VISIBLE to the bank feed.
 *
 * `loadLedgerItems` gated both the open and the settled balance item behind
 * `q.deposit_paid_at`. That is right for the residential ladder — no balance
 * exists until the deposit lands — and silently wrong for commercial, which has
 * no deposit rung at all: `deposit_amount` is 0 and `ensureDepositInvoice`
 * early-returns on the policy, so `deposit_paid_at` is never stamped by
 * anything. A commercial quote therefore produced ZERO ledger items, and its
 * `-BAL` completion invoice — frequently the entire agreed price — was in
 * neither pool.
 *
 * The consequence is not a cosmetic gap. `matchTransaction` filters `open`,
 * `reconcileSettled` filters `settled`, and the office's manual Attach flow
 * validates against `loadOpenItems`, which is `loadLedgerItems().open`. All
 * three were blind to it, so a commercial BACS payment landed in "needs a
 * human" permanently AND could not be attached by that human either.
 *
 * Migration 0113's runbook section and `classifyCommercial`'s own comment both
 * claim reusing the balance columns "keeps the bank-feed matcher working with
 * no new suffix and no new kind". The suffix half was true; the matcher half
 * was not. Both comments are corrected alongside this fix.
 */

const q = (over: Partial<Parameters<typeof balanceRungVisible>[0]> = {}) => ({
  lead_id: "lead-1",
  deposit_paid_at: null,
  payment_policy: "residential",
  zoho_balance_invoice_id: null,
  zoho_balance_invoice_number: null,
  ...over,
});

describe("balanceRungVisible — residential is unchanged", () => {
  it("hides the balance until the deposit is paid", () => {
    expect(balanceRungVisible(q({ deposit_paid_at: null }))).toBe(false);
  });

  it("shows it once the deposit is paid", () => {
    expect(balanceRungVisible(q({ deposit_paid_at: "2026-08-01T09:00:00Z" }))).toBe(true);
  });

  it("does not consult the invoice number — the deposit stamp is the residential gate", () => {
    // A raised balance invoice on an unpaid-deposit residential quote must NOT
    // open the rung: that ordering cannot happen on the ladder, and treating it
    // as visible here would be inventing a second definition of "balance due".
    expect(
      balanceRungVisible(
        q({ deposit_paid_at: null, zoho_balance_invoice_id: "inv_1", zoho_balance_invoice_number: "MMR001-BAL" }),
      ),
    ).toBe(false);
  });

  it("treats a null policy as residential", () => {
    // Quotes accepted before 0111 carry NULL, and 0111's backfill stamps only
    // already-accepted rows. Anything not explicitly commercial runs the
    // residential ladder — the same direction of default as resolvePaymentPolicy.
    expect(balanceRungVisible(q({ payment_policy: null, deposit_paid_at: "2026-08-01T09:00:00Z" }))).toBe(true);
    expect(balanceRungVisible(q({ payment_policy: null }))).toBe(false);
  });
});

describe("balanceRungVisible — commercial is visible once its invoice is RAISED", () => {
  it("shows the completion invoice with no deposit ever paid", () => {
    expect(
      balanceRungVisible(
        q({
          payment_policy: "commercial",
          deposit_paid_at: null,
          zoho_balance_invoice_id: "inv_9",
          zoho_balance_invoice_number: "PMR001-BAL",
        }),
      ),
    ).toBe(true);
  });

  it("stays hidden before the office raises it", () => {
    // Nothing is owed until the completion invoice exists (owedNow says the
    // same), so offering the matcher an item here would put money on the
    // /payments headline that nobody has been asked for.
    expect(balanceRungVisible(q({ payment_policy: "commercial" }))).toBe(false);
  });

  it("treats the 'pending' claim marker as NOT raised", () => {
    // createBalanceInvoiceFlow claims the slot by writing the literal "pending"
    // before it has a real id. load-signals derives balanceInvoiceNumber the
    // same way; the two must not disagree about whether an invoice exists.
    expect(
      balanceRungVisible(
        q({ payment_policy: "commercial", zoho_balance_invoice_id: "pending", zoho_balance_invoice_number: null }),
      ),
    ).toBe(false);
  });

  it("needs a lead to hang the item on, whatever the policy", () => {
    expect(
      balanceRungVisible(
        q({
          lead_id: null,
          payment_policy: "commercial",
          zoho_balance_invoice_id: "inv_9",
          zoho_balance_invoice_number: "PMR001-BAL",
        }),
      ),
    ).toBe(false);
  });
});

describe("loadLedgerItems actually uses it", () => {
  /**
   * The arithmetic above is worthless if the predicate is not wired in. Both
   * the lead-balance lookup and the push gate must go through it — the lookup
   * especially, because a quote missing from `leadIds` has no `lead` entry and
   * would fall through to the computed fallback amount even if the push gate
   * were fixed on its own.
   */
  const src = readFileSync(join(process.cwd(), "lib/bank-feed/sync.ts"), "utf8");

  it("routes both the lead lookup and the push gate through the predicate", () => {
    expect(src.split("balanceRungVisible(").length - 1).toBeGreaterThanOrEqual(3); // definition + 2 uses
    expect(
      src,
      "the raw deposit_paid_at gate is what hid commercial — it must not come back",
    ).not.toContain("quotes.filter((q) => q.deposit_paid_at && q.lead_id)");
    expect(src).not.toContain("if (q.deposit_paid_at && q.lead_id) {");
  });

  it("selects the columns the predicate reads", () => {
    // A predicate reading a column the query never asked for is undefined at
    // runtime and silently falsy — the same blindness in a new place. The
    // check anchors on loadLedgerItems' quotes SELECT string itself: the
    // predicate's own interface declaration also names these columns, so a
    // whole-file `toContain` stays green with the SELECT stripped bare.
    const fnAt = src.indexOf("export async function loadLedgerItems(");
    expect(fnAt, "loadLedgerItems must exist").toBeGreaterThan(-1);
    const selAt = src.indexOf(".select(", fnAt);
    expect(selAt, "loadLedgerItems must select from quotes").toBeGreaterThan(-1);
    const lit = /\.select\(\s*"([^"]+)"/.exec(src.slice(selAt, selAt + 600));
    expect(lit, "the quotes select must be a single string literal").not.toBeNull();
    const cols = (lit as RegExpExecArray)[1].split(",").map((c) => c.trim());
    for (const col of ["payment_policy", "zoho_balance_invoice_id", "zoho_balance_invoice_number"]) {
      expect(cols, `loadLedgerItems must select ${col}`).toContain(col);
    }
  });
});
