import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The Deposit cell must not invite a deposit on a commercial lead.
 *
 * A correctly-accepted commercial quote writes `deposit_amount = 0` and
 * `deposit_requested_at = null` — which is exactly the state the cell's
 * residential ladder reads as "not yet requested", so it fell through to the
 * £-input + "Request deposit" button. PRD §3.10: commercial takes no deposit,
 * no commitment, no customer chase — one invoice on completion, due on the
 * client's terms. The button's own toast says "chase queued", so pressing it
 * would start the residential machine against a client the policy says is
 * never chased.
 *
 * PR #178 made the Balance cell policy-aware; this locks the same guard onto
 * the Deposit cell. Asserted as source guards per the tests/components house
 * convention (vitest runs `environment: 'node'`, no jsdom/RTL): the properties
 * worth locking are structural — the commercial branch exists, it sits BEFORE
 * the request-deposit fallback, and the fallback itself is untouched so a
 * residential lead renders byte-identically.
 *
 * Every lookup goes through `at()`, which FAILS on a missing needle — a bare
 * indexOf returns -1 and orders "before" everything, which lets an ordering
 * assertion over two missing strings pass while proving nothing.
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

const SRC = read("components/leads/payments-card.tsx");
// The Deposit cell only — from its heading to the Commitment cell's.
const DEPOSIT = spanOf(SRC, "{/* Deposit */}", "{/* Commitment (25%)");

describe("the deposit cell knows which ladder it is rendering", () => {
  it("has a commercial branch, gated between the truthful states and the request fallback", () => {
    // Paid and requested are FACTS (real money, a real request) — if a
    // commercial lead somehow carries them, hiding them would hide money. The
    // guard's only job is to stop inviting a NEW residential request, so it
    // sits after both fact branches and before the fallback.
    const paid = at(DEPOSIT, "state.depositPaidAt ?", "the paid branch");
    const requested = at(DEPOSIT, "state.depositRequestedAt ?", "the requested branch");
    const guard = at(DEPOSIT, ": commercial ? (", "the commercial branch");
    const fallback = at(DEPOSIT, "Request deposit", "the residential request fallback");
    expect(paid).toBeLessThan(requested);
    expect(requested).toBeLessThan(guard);
    expect(guard).toBeLessThan(fallback);
  });

  it("the commercial state is static — a statement, not an ask", () => {
    // The commercial branch runs from its opener to the fallback's `) : (`.
    const commercialBranch = spanOf(DEPOSIT, ": commercial ? (", ") : (");
    at(commercialBranch, "None — business terms take no deposit.", "the no-deposit copy");
    // No affordance of any kind on this branch: nothing to press, nothing to
    // type. The £-input and the request button belong to the residential
    // fallback only.
    expect(commercialBranch).not.toContain("<Button");
    expect(commercialBranch).not.toContain("<input");
    expect(commercialBranch).not.toContain("requestDepositAction");
  });

  it("a residential lead still gets the request-deposit input, unchanged", () => {
    // The control: the residential ladder — £-input, aria label, action,
    // chase toast — survives as the cell's final else, which is what a
    // residential not-yet-requested lead resolves to. Sitting AFTER the
    // commercial guard is what makes it the else.
    const guard = at(DEPOSIT, ": commercial ? (", "the commercial branch");
    expect(at(DEPOSIT, 'aria-label="Deposit amount"', "the deposit £-input")).toBeGreaterThan(guard);
    expect(at(DEPOSIT, "requestDepositAction(leadId, Number(deposit))", "the request action")).toBeGreaterThan(guard);
    expect(at(DEPOSIT, '"Deposit requested — chase queued."', "the chase toast")).toBeGreaterThan(guard);
    expect(at(DEPOSIT, "Request deposit", "the request button label")).toBeGreaterThan(guard);
  });
});

describe("the card's other cells cannot invite residential-only actions on commercial", () => {
  it("the commitment cell renders only when a commitment invoice actually exists", () => {
    // Commercial raises no commitment, so `commitment` is null and the cell
    // is absent entirely — the gate is the prop itself, built by the lead page
    // only when `commitment_invoice_amount > 0`. When one EXISTS it is a real
    // Zoho artifact and displaying it (with resend) is truthful, so no policy
    // branch is needed here; what must hold is that the cell stays display-only
    // behind that null gate.
    const cell = spanOf(SRC, "{/* Commitment (25%) — only once one has been invoiced */}", "{/* Balance */}");
    at(cell, "{commitment ? (", "the null gate");
    expect(cell).not.toContain("requestDepositAction");
    expect(cell).not.toContain("setBalanceAction");
    const page = read("app/(dashboard)/leads/[id]/page.tsx");
    at(page, "commitmentAmount > 0", "the page-side commitment gate");
  });

  it("the balance cell's manual set-a-date box is still unreachable for commercial", () => {
    // PR #178's guard, re-asserted here so this file fails alone if either
    // cell regresses: the commercial branch sits before the manual fallback.
    const balance = spanOf(SRC, "{/* Balance */}", "</Card>");
    const guard = at(balance, ") : commercial ? (", "the balance commercial branch");
    expect(guard).toBeLessThan(at(balance, "Set manually", "the manual fallback"));
  });
});
