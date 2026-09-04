import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 869ett5y8: the Payments card infers "invoiced"/"requested" purely from
 * `leads.balance_amount` and `leads.deposit_requested_at` being non-null
 * (`components/leads/payments-card.tsx` — its "Balance" and "Deposit"
 * cells), which survive a cancel-and-reopen that voided the underlying
 * invoice(s) in the ledger. The card then shows a requested/invoiced state
 * (an amount, sometimes a due date) for a document that no longer exists in
 * the books.
 *
 * `updateLeadStatusAction`'s reopen branch already clears the `quotes` row's
 * own voided invoice references (`zoho_deposit_invoice_id`,
 * `zoho_balance_invoice_id`, `balance_invoice_amount`, `commercial_due_date`,
 * ...) — see the comment there explaining why: the unwind voided the Zoho
 * documents but left their ids on the quote, so every raiser early-returned
 * and the booking could never be invoiced again. What it did NOT clear —
 * originally for balance (fixed 2026-09-04, PR #226) and then deposit (this
 * fix) — is a SEPARATE denormalised copy on the `leads` table
 * (`deposit_amount`/`deposit_requested_at`, `balance_amount`/
 * `balance_due_date`), stamped by the same raises (`lib/quote/accept-flow.ts`)
 * and read directly by the Payments card
 * (`app/(dashboard)/leads/[id]/page.tsx` builds `state.depositAmount` /
 * `state.balanceAmount` from `lead.deposit_amount` / `lead.balance_amount`,
 * not from the quote). Clearing one table and not the other left the DISPLAY
 * stale even though the RAISER was correctly revived.
 *
 * Sibling of the deposit-cell fix (#182, a DIFFERENT bug — a commercial lead
 * falling through to the residential deposit input, not a void-state one).
 *
 * Asserted as source guards per the tests/components house convention
 * (vitest runs node env, no jsdom): the property worth locking is structural
 * — a `leads` clear exists, inside the `reopening` branch, alongside the
 * `quotes` clear it is meant to accompany, and covers both the deposit and
 * balance denormalised fields in one statement. Every lookup goes through
 * `at()`, which FAILS on a missing needle — a bare indexOf returns -1 and
 * orders "before" everything, which lets an ordering assertion over two
 * missing strings pass while proving nothing.
 */

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

const at = (haystack: string, needle: string, what: string): number => {
  const i = haystack.indexOf(needle);
  expect(i, `no longer contains ${what}`).toBeGreaterThan(-1);
  return i;
};

const spanOf = (src: string, from: string, to: string): string => {
  const start = src.indexOf(from);
  expect(start, `anchor not found: ${from}`).toBeGreaterThan(-1);
  const end = src.indexOf(to, start);
  expect(end, `anchor not found: ${to}`).toBeGreaterThan(start);
  return src.slice(start, end);
};

const SRC = read("app/(dashboard)/leads/actions.ts");
const ACTION = spanOf(
  SRC,
  "export async function updateLeadStatusAction",
  "export async function setReviewSuppressionAction",
);
// The reopen unwind only, not the whole action.
const REOPEN = spanOf(ACTION, "if (reopening) {", "// The cancel queued a refund.");
const LEADS_CLEAR = spanOf(REOPEN.slice(REOPEN.indexOf('.from("leads")')), "{", "}");

describe("updateLeadStatusAction's reopen unwind clears the stale leads.deposit_amount and balance_amount", () => {
  it("clears both denormalised deposit fields, not just the quote's own references", () => {
    const quotesClear = at(REOPEN, '.from("quotes")', "the quotes-table clear");
    const leadsClear = at(REOPEN, '.from("leads")', "the leads-table clear");
    // The leads clear comes AFTER the quotes clear — same ordering the block's
    // own comment documents (the quotes clear is what the raisers read; the
    // leads clear is what the Payments card reads).
    expect(quotesClear).toBeLessThan(leadsClear);
    expect(LEADS_CLEAR).toContain("deposit_amount: null");
    expect(LEADS_CLEAR).toContain("deposit_requested_at: null");
  });

  it("clears both denormalised balance fields in the same statement", () => {
    expect(LEADS_CLEAR).toContain("balance_amount: null");
    expect(LEADS_CLEAR).toContain("balance_due_date: null");
  });

  it("never touches deposit_paid_at or balance_paid_at — an already-paid rail is never voided in the first place", () => {
    expect(LEADS_CLEAR).not.toContain("deposit_paid_at");
    expect(LEADS_CLEAR).not.toContain("balance_paid_at");
  });

  it("fails soft — an ops alert, not a thrown error, so a failed clear cannot block reopening the lead", () => {
    const leadsClear = REOPEN.slice(REOPEN.indexOf('.from("leads")'));
    at(leadsClear, "leadReviveError", "the error variable");
    at(leadsClear, "sendOpsAlert", "the fail-soft ops alert");
  });
});
