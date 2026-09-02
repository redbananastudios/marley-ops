import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { owedNow, type OwedSignals } from "@/lib/bookings/queue";
import { depositOfQuote, requestedDeposit } from "@/lib/payments-policy";
import { balanceDue } from "@/lib/quote/payments";

/**
 * The commercial money model, at its source.
 *
 * A commercial booking has exactly ONE money figure — the completion invoice —
 * and `load-signals` derives it as `balanceDue(agreed, deposit + commitment)`.
 * That is residential machinery, and it was reading the deposit through a bare
 * `deposit_amount ?? defaultDeposit`, so the one figure came out short by a
 * deposit commercial never takes.
 *
 * The size of the shortfall was whatever the residential `requestedDeposit`
 * happened to write at acceptance, which is why this is asserted against that
 * function's REAL output rather than a hand-typed £100: the rule has three
 * branches, and the worst of them (small job → the ask IS the gross) left the
 * only commercial money figure at exactly zero.
 *
 * These shapes are not hypothetical for rows already in the table. Fixing the
 * accept path stops new ones being written; reading the deposit through
 * `depositOfQuote` is what makes a quote that ALREADY carries such a figure
 * report the right money.
 */

const TODAY = "2026-08-20";
const DEFAULT_DEPOSIT = 100;
const SMALL_JOB_THRESHOLD = 300;

/** The `balanceAmount` line of `loadBookingRows`, composed from the same parts. */
function reportedBalance(q: {
  payment_policy?: string | null;
  deposit_amount?: number | null;
  agreed: number;
  commitment_invoice_amount?: number | null;
  balance_invoice_amount?: number | null;
}): number {
  const deposit = depositOfQuote(q, DEFAULT_DEPOSIT);
  const commitmentCredit = Number(q.commitment_invoice_amount ?? 0);
  return Number(q.balance_invoice_amount ?? balanceDue(q.agreed, deposit + commitmentCredit));
}

describe("a commercial job reports the whole agreed price", () => {
  it("does not subtract the flat deposit an ordinary acceptance wrote", () => {
    // requestedDeposit's rule 3 — the plain Settings default — on a £2,400 job
    // booked well ahead. £2,400 was reported as £2,300.
    const wrote = requestedDeposit(2400, DEFAULT_DEPOSIT, "2026-10-01", SMALL_JOB_THRESHOLD, new Date(`${TODAY}T09:00:00Z`));
    expect(wrote).toBe(100);
    expect(reportedBalance({ payment_policy: "commercial", deposit_amount: wrote, agreed: 2400 })).toBe(2400);
  });

  it("does not subtract the 25% a late booking collapses to", () => {
    // Rule 2: the same £2,400 job four days out. The ask collapses to
    // max(£100, 25%) = £600, so the board reported £1,800 — the SAME job,
    // £500 further out, purely because of when it was booked.
    const wrote = requestedDeposit(2400, DEFAULT_DEPOSIT, "2026-08-24", SMALL_JOB_THRESHOLD, new Date(`${TODAY}T09:00:00Z`));
    expect(wrote).toBe(600);
    expect(reportedBalance({ payment_policy: "commercial", deposit_amount: wrote, agreed: 2400 })).toBe(2400);
  });

  it("a small job does not report £0 due on a bill nobody has paid", () => {
    // Rule 1 is the one that turns a wrong figure into no figure. At or under
    // the small-job threshold the ask IS the gross, so deposit_amount == agreed
    // and the balance clamped to zero: `owedNow` returned £0, and the invoiced
    // section printed "£0 due" against a live commercial job.
    const wrote = requestedDeposit(280, DEFAULT_DEPOSIT, "2026-10-01", SMALL_JOB_THRESHOLD, new Date(`${TODAY}T09:00:00Z`));
    expect(wrote).toBe(280);
    expect(reportedBalance({ payment_policy: "commercial", deposit_amount: wrote, agreed: 280 })).toBe(280);
  });

  it("a commercial quote with no deposit column reports the full price too", () => {
    // The shape a correctly-accepted commercial booking has from now on, and
    // the one the `?? defaultDeposit` fallback silently charged £100 for.
    expect(reportedBalance({ payment_policy: "commercial", deposit_amount: null, agreed: 2400 })).toBe(2400);
    expect(reportedBalance({ payment_policy: "commercial", deposit_amount: 0, agreed: 2400 })).toBe(2400);
  });

  it("never credits a 25% commitment either — commercial has no such rung", () => {
    // A stale figure on the row must not reach the one invoice the client gets.
    expect(
      reportedBalance({
        payment_policy: "commercial",
        deposit_amount: null,
        commitment_invoice_amount: 600,
        agreed: 2400,
      }),
    ).toBe(1800);
  });

  it("trusts the raised invoice's frozen figure once it exists", () => {
    // Same rule as residential: after the completion invoice is raised, the
    // billed amount is the truth, not a re-derivation.
    expect(
      reportedBalance({
        payment_policy: "commercial",
        deposit_amount: null,
        balance_invoice_amount: 2400,
        agreed: 2400,
      }),
    ).toBe(2400);
  });
});

describe("residential is untouched by the commercial fix", () => {
  // The PRD's headline property. Every one of these is the arithmetic
  // /bookings did before gate 10 existed, asserted rather than assumed.
  it("still subtracts the deposit the customer was actually asked for", () => {
    expect(reportedBalance({ payment_policy: "residential", deposit_amount: 100, agreed: 2400 })).toBe(2300);
    expect(reportedBalance({ payment_policy: "residential", deposit_amount: 600, agreed: 2400 })).toBe(1800);
  });

  it("still falls back to the Settings default when the column is null", () => {
    expect(reportedBalance({ payment_policy: "residential", deposit_amount: null, agreed: 2400 })).toBe(2300);
    expect(reportedBalance({ payment_policy: null, deposit_amount: null, agreed: 2400 })).toBe(2300);
    expect(reportedBalance({ deposit_amount: null, agreed: 2400 })).toBe(2300);
  });

  it("still subtracts deposit AND raised commitment together", () => {
    expect(
      reportedBalance({
        payment_policy: "residential",
        deposit_amount: 100,
        commitment_invoice_amount: 500,
        agreed: 2400,
      }),
    ).toBe(1800);
  });

  it("still clamps a small residential job's balance to zero", () => {
    // Gate 9a: the ask IS the gross, so nothing remains. Unchanged — for
    // residential this is correct, because the whole job was genuinely asked
    // for up front. It is only wrong when nothing was asked for at all.
    expect(reportedBalance({ payment_policy: "residential", deposit_amount: 280, agreed: 280 })).toBe(0);
  });
});

describe("what the office is shown to collect", () => {
  const owedBase: OwedSignals = {
    paymentPolicy: "commercial",
    commercialDueDate: null,
    commitmentInvoiceAmount: 0,
    commitmentPaidAt: null,
    commitmentDueDate: null,
    dateReleasableAt: null,
    balanceAmount: 0,
    balancePaidAt: null,
    balanceInvoiceNumber: null,
    hasRemovalAppt: true,
    apptDayUk: "2026-08-14",
  };

  it("a raised small-job commercial invoice is real money, not £0", () => {
    // End to end on the worst shape: the figure reaching owedNow is now the
    // agreed price, so the invoiced section shows £280 rather than nothing.
    const balanceAmount = reportedBalance({
      payment_policy: "commercial",
      deposit_amount: 280,
      agreed: 280,
    });
    const owed = owedNow(
      {
        ...owedBase,
        balanceAmount,
        balanceInvoiceNumber: "INV-000401",
        commercialDueDate: "2026-09-13",
      },
      TODAY,
    );
    expect(owed.balance).toBe(280);
    expect(owed.total).toBe(280);
  });
});

/**
 * The wiring, asserted at the source. Both call sites are deep IO — one needs
 * the whole Supabase + ledger stack, the other a paged query — and the property
 * worth protecting is not the arithmetic above but that these two functions
 * actually reach it. A future edit that inlines `?? defaultDeposit` back into
 * either one is exactly what this catches, and it is the same failure both
 * times: the fallback applied to a policy with nothing to fall back to.
 */
const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("both readers of the deposit go through the policy-aware helper", () => {
  it("/bookings derives its balance from depositOfQuote", () => {
    const src = read("lib/bookings/load-signals.ts");
    expect(src).toContain("depositOfQuote(");
    expect(src).not.toContain("Number(q.deposit_amount ?? settings.defaultDeposit)");
  });

  it("the completion invoice's own figure does too", () => {
    // This is the half that reaches the CUSTOMER. computeBalanceCredits
    // partitions the agreed price on the assumption that a -DEP invoice exists
    // demanding the carve-out; on a commercial booking none ever does, so every
    // penny deducted there is never billed to anybody at all.
    const src = read("lib/quote/accept-flow.ts");
    const at = src.indexOf("export async function computeBalanceCredits(");
    expect(at, "computeBalanceCredits not found — rename it here too").toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf("\n}", at));
    expect(body).toContain("depositOfQuote(quote, settings.defaultDeposit)");
    expect(body).not.toContain("quote.deposit_amount ?? settings.defaultDeposit");
  });
});

/**
 * The completion invoice must survive the lead being marked "Completed".
 *
 * `loadBookingRows` dropped every `completed` lead. That retires a RESIDENTIAL
 * booking correctly — its ladder is finished by then — and is exactly backwards
 * for commercial, which is invoiced BY HAND on completion and then sits 30-60
 * days on the client's terms. `completed` is the status it carries for the whole
 * window the credit-control alarm exists for.
 *
 * The dangerous half was not the hidden row. `sweepCommercialOverdue`
 * classifies off this same loader and, on an empty list, takes its `else`
 * branch and RESOLVES the alarm — so a routine "Mark completed" click (a button
 * on the lead action bar, and a kanban drag) cleared an alarm that may already
 * have fired. Nothing else covers it: the post-move sweep `continue`s on
 * commercial by design, so no follow-up and no ops alert is raised for it, and
 * by policy the customer is never chased.
 */
describe("a commercial job stays visible until its money is settled", () => {
  const src = read("lib/bookings/load-signals.ts");

  it("no longer drops every completed lead in one breath", () => {
    expect(
      src,
      "the combined skip is what hid the commercial invoice — it must not come back",
    ).not.toContain('if (lead.status === "completed" || lead.status === "declined") continue;');
  });

  it("keeps a commercial row whose balance has not been paid", () => {
    expect(src).toContain('q.payment_policy === "commercial" && !lead.balance_paid_at');
    expect(src).toContain('if (lead.status === "completed" && !commercialUnsettled) continue;');
  });

  it("still retires declined leads unconditionally", () => {
    expect(src).toContain('if (lead.status === "declined") continue;');
  });

  it("settles on balance_paid_at — the same stamp classifyCommercial reads", () => {
    // Not a second definition of "done". classifyCommercial returns all_set on
    // `s.balancePaidAt`; if these two ever disagree, the alarm fires for rows
    // the office cannot find, or stays silent for rows shown in red.
    const queue = read("lib/bookings/queue.ts");
    expect(queue).toContain("if (s.balancePaidAt) return \"all_set\";");
  });

  it("the overdue sweep still classifies off this loader, not its own query", () => {
    // One classifier, three surfaces — the sweep's own doc comment. A second
    // definition of overdue is how the page and the alarm drift apart.
    const sweep = read("lib/ops/commercial-overdue.ts");
    expect(sweep).toContain("loadBookingRows(sb, { strict: true })");
    expect(sweep).toContain('r.bucket === "commercial_overdue"');
  });

  it("reads it STRICTLY — a failed read must not arrive as an empty ledger", () => {
    // The loader fail-softs by default (the pages want that). This sweep
    // resolves both alarms on an empty list, so an unstrict read here means a
    // broken query clears live credit control and reports itself clean. Pinned
    // in the loader too, behaviourally, in load-signals.test.ts.
    const loader = read("lib/bookings/load-signals.ts");
    expect(loader).toContain("{ strict }");
    expect(loader).toContain("failIfStrict(\"leads\", leadsError)");
  });
});
