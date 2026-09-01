import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { balanceDueDateForMove, paymentTermsDueDate, policyOfQuote } from "@/lib/payments-policy";
import { balanceDueDate } from "@/lib/quote/payments";
import { lateBalanceDueAtAcceptance, type LateBalanceQuote } from "@/lib/payments/late-balance";

/**
 * A commercial booking's money date does not come from its move day.
 *
 * The two ladders date their one remaining money figure from different facts.
 * Residential works BACK from the move — the balance is due the day before,
 * because the customer must have paid before we load the van. Commercial works
 * FORWARD from the day the completion invoice was raised, plus the client's own
 * terms, because the job is already done and the client is being extended
 * credit. `paymentTermsDueDate` is the whole of that second rule.
 *
 * Both date-change paths recomputed `leads.balance_due_date` as
 * `balanceDueDate(newMoveDate)` for EVERY accepted quote, with no policy check
 * in either function. So a completed commercial job whose invoice was already
 * raised and correctly dated 30 days out had that date silently replaced with a
 * day-before-move one the moment anybody moved the appointment — and the open
 * `reason = "balance"` follow-up was re-dated the same wrong way, dropping the
 * task into the overdue section of the queue for a client who is not late and
 * is never chased.
 *
 * The invoice may also not have been raised yet, in which case there is no
 * terms date in existence. That case must produce NO date rather than a
 * confident wrong one: an invented date on an uninvoiced job is the shape this
 * codebase keeps getting bitten by, where the reassuring answer is manufactured
 * out of having no information at all.
 */

const TODAY = new Date("2026-09-01T09:00:00Z");

/* ------------------------------------------------------------ the pure rule */

describe("balanceDueDateForMove — which fact dates the money", () => {
  it("residential is the day before the move, exactly as before", () => {
    // Byte-for-byte the existing call: `balanceDueDate(newMoveDate)`. This is
    // the invariant the whole change is measured against.
    for (const move of ["2026-10-01", "2026-09-15", "2026-09-02"]) {
      expect(balanceDueDateForMove({ payment_policy: "residential" }, move, TODAY)).toBe(
        balanceDueDate(move, TODAY),
      );
    }
    expect(balanceDueDateForMove({ payment_policy: "residential" }, "2026-10-01", TODAY)).toBe(
      "2026-09-30",
    );
  });

  it("residential keeps the fallback for a move that is already in the past", () => {
    // `balanceDueDate` falls back to today+3 when the day-before has passed.
    expect(balanceDueDateForMove({ payment_policy: "residential" }, "2026-08-01", TODAY)).toBe(
      balanceDueDate("2026-08-01", TODAY),
    );
    expect(balanceDueDateForMove({ payment_policy: "residential" }, "2026-08-01", TODAY)).toBe(
      "2026-09-04",
    );
  });

  it("an unknown or absent policy is residential — every booking before gate 8", () => {
    // Same direction as `policyOfQuote`: unknown means the ladder every booking
    // has always run, so a null column cannot silently switch a job's money off.
    expect(balanceDueDateForMove({ payment_policy: null }, "2026-10-01", TODAY)).toBe("2026-09-30");
    expect(balanceDueDateForMove({}, "2026-10-01", TODAY)).toBe("2026-09-30");
    expect(balanceDueDateForMove(null, "2026-10-01", TODAY)).toBe("2026-09-30");
    expect(balanceDueDateForMove(undefined, "2026-10-01", TODAY)).toBe("2026-09-30");
    expect(policyOfQuote({ payment_policy: null })).toBe("residential");
  });

  it("commercial with an invoice already raised yields NO date — the terms date stands", () => {
    // The completion invoice stamped `commercial_due_date` from the client's own
    // terms. Nothing about moving the van changes when that invoice falls due,
    // so this path has no business writing a date at all.
    const raised = paymentTermsDueDate("2026-08-20", 30);
    expect(raised).toBe("2026-09-19");
    expect(
      balanceDueDateForMove(
        { payment_policy: "commercial", commercial_due_date: raised },
        "2026-10-01",
        TODAY,
      ),
    ).toBeNull();
  });

  it("commercial with no invoice yet yields NO date either — nothing to state", () => {
    // Fails to nothing, not to a guess. There is no terms date in existence
    // until the office raises the completion invoice, and a day-before-move
    // date would be an assertion made out of having no information.
    expect(
      balanceDueDateForMove(
        { payment_policy: "commercial", commercial_due_date: null },
        "2026-10-01",
        TODAY,
      ),
    ).toBeNull();
    expect(balanceDueDateForMove({ payment_policy: "commercial" }, "2026-10-01", TODAY)).toBeNull();
  });

  it("commercial never returns a date for ANY move, near, far or past", () => {
    for (const move of ["2026-10-01", "2026-09-02", "2026-08-01", null, undefined, ""]) {
      expect(balanceDueDateForMove({ payment_policy: "commercial" }, move, TODAY)).toBeNull();
    }
  });

  it("a missing move date still resolves for residential, so today's behaviour holds", () => {
    expect(balanceDueDateForMove({ payment_policy: "residential" }, null, TODAY)).toBe(
      balanceDueDate(null, TODAY),
    );
  });

  it("RESIDENTIAL IS TOTAL — it never returns null, for any input at all", () => {
    // The single most load-bearing assertion in this file. Both call sites now
    // wrap their two writes in `if (dueDate)`, and that guard is a behaviour
    // change ONLY if residential can produce a falsy answer. `balanceDueDate`
    // has a fallback on every branch (today + 3 days), so it cannot — which is
    // what makes the new guard commercial-only in effect as well as in intent.
    // If this ever fails, a residential booking has silently stopped having its
    // balance re-dated on a reschedule and nothing else would say so.
    const inputs = [
      "2026-10-01",
      "2026-09-02",
      "2026-09-01",
      "2026-08-01",
      "1999-01-01",
      "2026-10-01T13:45:00Z",
      "not-a-date",
      "",
      null,
      undefined,
    ];
    for (const policy of ["residential", null, undefined] as const) {
      for (const move of inputs) {
        const out = balanceDueDateForMove({ payment_policy: policy }, move, TODAY);
        expect(out, `residential returned falsy for ${JSON.stringify(move)}`).toBeTruthy();
        expect(out).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        // And it is the SAME string the old code wrote, character for character.
        expect(out).toBe(balanceDueDate(move, TODAY));
      }
    }
  });
});

/* ----------------------------------------------- finding 5: the accept rule */

/**
 * `lateBalanceDueAtAcceptance` claimed in its own docstring that commercial was
 * excluded "at the accept-flow choke point". There is no such choke point.
 * `ensureLateBookingBalanceInvoice` has six call sites and the commercial
 * refusal guards exactly one of the paths that reach them — the NEW-acceptance
 * branch of the online flow. The already-accepted self-heal branches call it
 * with no policy check at all.
 *
 * It does not fire today, but only because office "Mark won" happens not to
 * write a `kind: "contract"` signature row. That is an incidental property of a
 * different function, not a guard this rule asserts, and it is one refactor away
 * from raising a residential T-7 final invoice against a business client.
 */
const commercialQuote = (over: Partial<LateBalanceQuote> = {}): LateBalanceQuote => ({
  status: "accepted",
  payment_policy: "commercial",
  moving_date: "2026-09-03", // inside T-7 of TODAY, so every other gate passes
  zoho_balance_invoice_id: null,
  booking_cancelled_at: null,
  source: null,
  standard_comms_at: null,
  ...over,
});

describe("lateBalanceDueAtAcceptance asserts the policy itself", () => {
  it("refuses a commercial quote even with a contract signature on file", () => {
    expect(lateBalanceDueAtAcceptance(commercialQuote(), true, TODAY)).toBe(false);
  });

  it("still raises for the identical residential booking", () => {
    // The control: everything else about this quote qualifies, so the refusal
    // above is the policy and nothing else.
    expect(lateBalanceDueAtAcceptance(commercialQuote({ payment_policy: "residential" }), true, TODAY)).toBe(
      true,
    );
    expect(lateBalanceDueAtAcceptance(commercialQuote({ payment_policy: null }), true, TODAY)).toBe(true);
  });

  it("the docstring no longer claims a choke point that does not exist", () => {
    // The false statement was itself the defect: it told the next reader the
    // safety lived somewhere else, so nobody added it here. The header may still
    // RECOUNT the old claim (it does, as the reason the guard exists) — what it
    // must never again do is assert that this rule delegates the check.
    const src = readFileSync(join(process.cwd(), "lib/payments/late-balance.ts"), "utf8");
    expect(src).not.toContain("Also not checked here: commercial");
    expect(src).toContain("policyOfQuote(");
  });
});

/* ------------------------------------------------- the wiring, at the source */

/**
 * Both date-change paths are deep IO — a Supabase client, a diary row, a ledger
 * and an email each. The property worth pinning is not the arithmetic above but
 * that these two functions actually consult it, so a future edit cannot inline
 * `balanceDueDate(newMoveDate)` back into either one.
 */
const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

const spanOf = (src: string, from: string, to: string): string => {
  const start = src.indexOf(from);
  expect(start, `anchor not found: ${from}`).toBeGreaterThan(-1);
  const end = src.indexOf(to, start);
  expect(end, `anchor not found: ${to}`).toBeGreaterThan(start);
  return src.slice(start, end);
};

describe("both date-change paths date the money through the policy", () => {
  it("rescheduleAppointment reads the policy off the quote it is about to re-date", () => {
    const src = read("app/(dashboard)/schedule/actions.ts");
    const span = spanOf(src, "export async function rescheduleAppointment(", "\n  // A moved SURVEY");
    expect(span.length).toBeGreaterThan(1000);
    // It cannot honour a policy it never selected.
    expect(span).toContain("payment_policy");
    expect(span).toContain("balanceDueDateForMove(");
    // And it must not re-derive the date from the move behind the helper's back.
    expect(span).not.toContain("balanceDueDate(newMoveDate)");
  });

  it("rescheduleAppointment writes neither the lead date nor the follow-up when there is none", () => {
    const src = read("app/(dashboard)/schedule/actions.ts");
    const span = spanOf(src, "export async function rescheduleAppointment(", "\n  // A moved SURVEY");
    const guard = span.indexOf("if (dueDate)");
    const leadWrite = span.indexOf("balance_due_date: dueDate");
    const followUp = span.indexOf('.eq("reason", "balance")');
    expect(guard, "the null date must gate both writes").toBeGreaterThan(-1);
    expect(guard).toBeLessThan(leadWrite);
    expect(guard).toBeLessThan(followUp);
  });

  it("changeBookingDateAction does the same on the cancel-and-rebook path", () => {
    const src = read("app/actions/booking-change.ts");
    // The quote columns it reads must carry the policy AND the terms date.
    expect(src).toContain("payment_policy");
    expect(src).toContain("commercial_due_date");
    const span = spanOf(src, "// 3. Money dates roll with the move", "// Re-arm the night-before crew reminder");
    expect(span.length).toBeGreaterThan(400);
    expect(span).toContain("balanceDueDateForMove(");
    expect(span).not.toContain("balanceDueDate(newMoveDay)");
    const guard = span.indexOf("if (dueDate)");
    expect(guard, "the null date must gate both writes").toBeGreaterThan(-1);
    expect(guard).toBeLessThan(span.indexOf("balance_due_date: dueDate"));
    expect(guard).toBeLessThan(span.indexOf('.eq("reason", "balance")'));
  });

  it("the move date itself still follows the diary on both paths", () => {
    // Only the MONEY date is policy-bound. The move moved; `quotes.moving_date`
    // must still say so, or the crew sheet and the diary disagree.
    expect(read("app/(dashboard)/schedule/actions.ts")).toContain("moving_date: newMoveDate");
    expect(read("app/actions/booking-change.ts")).toContain("moving_date: newMoveDay");
  });
});

/* -------------------------------------------------- the reader on the screen */

/**
 * The card printed `{gbp(balanceAmount)} due {fmt(balanceDueDate)}` as plain
 * fact, and the page handed it `lead.balance_due_date` with no policy anywhere
 * in the file. That is the surface that put the corrupted value in front of the
 * office, so knowing the policy is the minimum honest fix.
 */
describe("the payments card knows which ladder it is rendering", () => {
  it("PaymentState carries the policy and the commercial terms date", () => {
    const src = read("components/leads/payments-card.tsx");
    const span = spanOf(src, "export interface PaymentState {", "}");
    expect(span).toContain("paymentPolicy");
    expect(span).toContain("commercialDueDate");
  });

  it("the card never states a move-day balance date for a commercial lead", () => {
    const src = read("components/leads/payments-card.tsx");
    expect(src).toContain('state.paymentPolicy === "commercial"');
    // The bare interpolation of the lead's own column is what has to go.
    expect(src).not.toContain("due {fmt(state.balanceDueDate)}");
  });

  it("a residential lead still renders the lead's own column, unchanged", () => {
    const src = read("components/leads/payments-card.tsx");
    // The date the card prints is the lead's column for residential and the
    // quote's terms date for commercial — one ternary, so a residential render
    // resolves to exactly what it printed before.
    expect(src).toContain("commercial ? state.commercialDueDate : state.balanceDueDate");
    // And the new copy is reachable ONLY on the commercial branch, so nothing a
    // residential lead can be in state-wise can produce it.
    const span = spanOf(src, "{/* Balance */}", "</Card>");
    const commercialBranch = span.indexOf(") : commercial ? (");
    expect(commercialBranch, "the commercial branch must exist and be gated").toBeGreaterThan(-1);
    expect(span.indexOf("Business terms")).toBeGreaterThan(commercialBranch);
    expect(span.indexOf("no terms date recorded")).toBeGreaterThan(commercialBranch);
    // The residential manual-set fallback still sits last and still exists.
    expect(span.indexOf("Set manually")).toBeGreaterThan(span.indexOf("Business terms"));
  });

  it("the lead page passes the policy through, from the accepted quote", () => {
    const src = read("app/(dashboard)/leads/[id]/page.tsx");
    // The columns it selects, and the props it hands over.
    expect(src).toContain("payment_policy");
    expect(src).toContain("commercial_due_date");
    expect(src).toContain("paymentPolicy:");
    expect(src).toContain("commercialDueDate:");
  });
});
