import { describe, expect, it } from "vitest";
import {
  COMMITMENT_DUE_DAYS_BEFORE,
  COMMITMENT_PCT,
  commitmentAmount,
  commitmentDueDate,
  commitmentDueImmediately,
  DEFAULT_PAYMENT_TERMS_DAYS,
  paymentTermsDays,
  paymentTermsDueDate,
  policyOfQuote,
  resolvePaymentPolicy,
  isInsideChangeWindow,
  refundOutcome,
  requestedDeposit,
  splitHeldMoney,
  type HeldPayment,
} from "@/lib/payments-policy";
import { balanceReference, commitmentReference, depositReference } from "@/lib/quote/payments";
import {
  allDateConfirmAcksConfirmed,
  DATE_CONFIRM_ACKS,
  normalizeDateConfirmAcks,
} from "@/lib/signatures";

/**
 * Payments Policy v2 engine (docs/payments-policy-v2-prd.md §3). Load-bearing:
 * the commitment ladder, the 7-day boundary, and the 25%-cap chronological
 * split all decide real customer money — every rule is locked on both sides
 * of its boundary here.
 */

const held = (rail: HeldPayment["rail"], amount: number, at: string, label?: string): HeldPayment => ({
  rail,
  amount,
  at,
  label,
});

/* --------------------------------------------------------- commitmentAmount */

describe("commitmentAmount", () => {
  it("is 25% of gross minus the actual deposit (PRD worked example)", () => {
    // £2,400 job, £100 deposit → £500 commitment.
    expect(commitmentAmount(2400, 100)).toBe(500);
  });

  it("respects a per-quote deposit override — the deposit is never assumed £100", () => {
    expect(commitmentAmount(2400, 250)).toBe(350);
  });

  it("suppresses to zero when 25% of gross does not exceed the deposit (small job)", () => {
    // £360 job: 25% = £90 ≤ £100 deposit → nothing further to invoice.
    expect(commitmentAmount(360, 100)).toBe(0);
  });

  it("suppresses at exact equality", () => {
    expect(commitmentAmount(400, 100)).toBe(0); // 25% = exactly the deposit
  });

  it("never goes negative", () => {
    expect(commitmentAmount(0, 100)).toBe(0);
    expect(commitmentAmount(100, 500)).toBe(0);
  });

  it("rounds to 2dp", () => {
    expect(commitmentAmount(1234.56, 100)).toBe(208.64); // 308.64 − 100
    expect(commitmentAmount(1234.57, 0)).toBe(308.64); // 308.6425 → 308.64
  });

  it("treats null-ish inputs as zero", () => {
    expect(commitmentAmount(Number.NaN, Number.NaN)).toBe(0);
  });
});

/* -------------------------------------------------------- commitmentDueDate */

describe("commitmentDueDate", () => {
  it("is move date minus 7 days when confirmation is early", () => {
    expect(commitmentDueDate("2026-08-20", new Date("2026-07-21T10:00:00Z"))).toBe("2026-08-13");
  });

  it("late collapse: confirmation inside move−7d is due TODAY", () => {
    // Move 25 Jul, confirmed 21 Jul → move−7 = 18 Jul is already past → today.
    expect(commitmentDueDate("2026-07-25", new Date("2026-07-21T10:00:00Z"))).toBe("2026-07-21");
  });

  it("exactly 7 days out lands due today without clamping", () => {
    expect(commitmentDueDate("2026-07-28", new Date("2026-07-21T10:00:00Z"))).toBe("2026-07-21");
  });

  it("uses the UK wall-clock day, not the UTC day (BST 23:30Z is tomorrow)", () => {
    // 21 Jul 23:30 UTC = 22 Jul 00:30 UK. Move 28 Jul: move−7 = 21 Jul, which
    // is already behind the UK "today" → clamps to 22 Jul, not 21 Jul.
    expect(commitmentDueDate("2026-07-28", new Date("2026-07-21T23:30:00Z"))).toBe("2026-07-22");
    // And an early confirmation is unaffected.
    expect(commitmentDueDate("2026-08-10", new Date("2026-07-21T23:30:00Z"))).toBe("2026-08-03");
  });

  it("winter (GMT): 23:30Z is still the same UK day", () => {
    expect(commitmentDueDate("2026-01-20", new Date("2026-01-10T23:30:00Z"))).toBe("2026-01-13");
  });

  it("collapses to today when the move date is missing or malformed", () => {
    expect(commitmentDueDate(null, new Date("2026-07-21T10:00:00Z"))).toBe("2026-07-21");
    expect(commitmentDueDate("not-a-date", new Date("2026-07-21T10:00:00Z"))).toBe("2026-07-21");
  });
});

/**
 * Gate 9a made requestedDeposit's small-job threshold a REQUIRED parameter, so
 * every call below names it. These cases predate the rule and lock the ladder
 * that still runs underneath it, so they pass 0 — the rule explicitly off —
 * rather than a value that happens not to trigger. The rule's own behaviour,
 * including where it overrides these, is asserted separately further down.
 */
const NO_SMALL_JOB = 0;

/* --------------------------------------- late-booking collapse (25% up-front) */

describe("requestedDeposit — the late-booking collapse", () => {
  const today = new Date("2026-08-05T10:00:00Z");

  it("Brydee's case: £600 job 7 days out asks £150 up-front, not £100 + £50 later", () => {
    expect(requestedDeposit(600, 100, "2026-08-12", NO_SMALL_JOB, today)).toBe(150);
    // ...and the commitment machinery never engages for that deposit.
    expect(commitmentAmount(600, 150)).toBe(0);
  });

  it("8 days out is the normal ladder — the base deposit stands", () => {
    expect(requestedDeposit(600, 100, "2026-08-13", NO_SMALL_JOB, today)).toBe(100);
  });

  it("a small job's 25% under the base deposit never LOWERS the ask", () => {
    // £300 job → 25% = £75 < £100 base.
    expect(requestedDeposit(300, 100, "2026-08-10", NO_SMALL_JOB, today)).toBe(100);
  });

  it("a big late job asks the full 25%", () => {
    expect(requestedDeposit(2400, 100, "2026-08-09", NO_SMALL_JOB, today)).toBe(600);
  });

  it("an office-set base above 25% is respected (max, never a reduction)", () => {
    expect(requestedDeposit(600, 200, "2026-08-10", NO_SMALL_JOB, today)).toBe(200);
  });

  it("no move date → no collapse (there is nothing to secure yet)", () => {
    expect(requestedDeposit(600, 100, null, NO_SMALL_JOB, today)).toBe(100);
    expect(requestedDeposit(600, 100, "not-a-date", NO_SMALL_JOB, today)).toBe(100);
  });

  it("rounds to 2dp", () => {
    expect(requestedDeposit(999.99, 100, "2026-08-10", NO_SMALL_JOB, today)).toBe(250);
  });
});

describe("commitmentDueImmediately", () => {
  const today = new Date("2026-08-05T10:00:00Z");

  it("true at exactly 7 days out and closer, false at 8", () => {
    expect(commitmentDueImmediately("2026-08-12", today)).toBe(true);
    expect(commitmentDueImmediately("2026-08-06", today)).toBe(true);
    expect(commitmentDueImmediately("2026-08-13", today)).toBe(false);
  });

  it("false with no usable move date (unlike commitmentDueDate's today-collapse)", () => {
    expect(commitmentDueImmediately(null, today)).toBe(false);
    expect(commitmentDueImmediately("not-a-date", today)).toBe(false);
  });
});

/* ---------------------------------------------------- isInsideChangeWindow */

describe("isInsideChangeWindow", () => {
  const today = new Date("2026-07-21T10:00:00Z");

  it("exactly 7 days out is OUTSIDE (free change) — boundary locked", () => {
    expect(isInsideChangeWindow("2026-07-28", today)).toBe(false);
  });

  it("6 days out is inside — boundary locked on the other side", () => {
    expect(isInsideChangeWindow("2026-07-27", today)).toBe(true);
  });

  it("8 days out is outside", () => {
    expect(isInsideChangeWindow("2026-07-29", today)).toBe(false);
  });

  it("move day itself and past moves are inside", () => {
    expect(isInsideChangeWindow("2026-07-21", today)).toBe(true);
    expect(isInsideChangeWindow("2026-07-01", today)).toBe(true);
  });

  it("counts UK calendar days, not UTC (BST midnight straddle)", () => {
    // 23:30Z on 21 Jul = 22 Jul in the UK → the 28 Jul move is 6 UK days off,
    // INSIDE — a raw-UTC diff would call it 7/outside and skip the queue row.
    expect(isInsideChangeWindow("2026-07-28", new Date("2026-07-21T23:30:00Z"))).toBe(true);
  });

  it("no move date → no window", () => {
    expect(isInsideChangeWindow(null, today)).toBe(false);
    expect(isInsideChangeWindow("garbage", today)).toBe(false);
  });

  it("window width and due offset share one constant", () => {
    expect(COMMITMENT_DUE_DAYS_BEFORE).toBe(7);
    expect(COMMITMENT_PCT).toBe(0.25);
  });
});

/* ---------------------------------------------------------- splitHeldMoney */

describe("splitHeldMoney", () => {
  it("PRD example: £100 card + £350 bank on a £1,400 job → £250 of the bank held, £100 bank unconditional", () => {
    const split = splitHeldMoney(
      [held("card", 100, "2026-07-01T10:00:00Z"), held("bank_transfer", 350, "2026-07-10T10:00:00Z")],
      1400,
    );
    expect(split.cap).toBe(350);
    expect(split.conditional).toBe(350);
    expect(split.unconditional).toBe(100);
    expect(split.total).toBe(450);
    expect(split.allocations).toEqual([
      expect.objectContaining({ conditional: 100, unconditional: 0 }),
      expect.objectContaining({ conditional: 250, unconditional: 100 }),
    ]);
    expect(split.byRail.card).toEqual({ conditional: 100, unconditional: 0, total: 100 });
    expect(split.byRail.bank_transfer).toEqual({ conditional: 250, unconditional: 100, total: 350 });
    expect(split.byRail.cash).toEqual({ conditional: 0, unconditional: 0, total: 0 });
  });

  it("fills the cap chronologically by `at`, never by array order", () => {
    const split = splitHeldMoney(
      [
        // Listed card-first, but the bank transfer landed EARLIER.
        held("card", 100, "2026-07-10T10:00:00Z"),
        held("bank_transfer", 350, "2026-07-01T10:00:00Z"),
      ],
      1400,
    );
    // Bank (first in) soaks the whole £350 cap; the later card £100 is above it.
    expect(split.byRail.bank_transfer.conditional).toBe(350);
    expect(split.byRail.card.conditional).toBe(0);
    expect(split.byRail.card.unconditional).toBe(100);
  });

  it("money above 25% of gross is ALWAYS unconditional, whatever the determination will be", () => {
    const split = splitHeldMoney(
      [held("bank_transfer", 100, "2026-07-01"), held("bank_transfer", 500, "2026-07-02")],
      1000,
    );
    expect(split.cap).toBe(250);
    expect(split.conditional).toBe(250);
    expect(split.unconditional).toBe(350);
  });

  it("zero gross (no accepted price) → nothing is retainable", () => {
    const split = splitHeldMoney([held("card", 100, "2026-07-01")], 0);
    expect(split.conditional).toBe(0);
    expect(split.unconditional).toBe(100);
  });

  it("empty payments → all zeros", () => {
    const split = splitHeldMoney([], 2400);
    expect(split.total).toBe(0);
    expect(split.allocations).toEqual([]);
  });

  it("penny-exact: per payment, conditional + unconditional reconstruct the amount", () => {
    const payments = [
      held("card", 33.33, "2026-07-01"),
      held("bank_transfer", 66.67, "2026-07-02"),
      held("cash", 0.01, "2026-07-03"),
    ];
    const split = splitHeldMoney(payments, 133.34); // cap 33.34 (33.335 rounds)
    for (const a of split.allocations) {
      expect(Math.round((a.conditional + a.unconditional) * 100)).toBe(
        Math.round(a.payment.amount * 100),
      );
    }
    expect(Math.round((split.conditional + split.unconditional) * 100)).toBe(10001);
  });
});

/* ------------------------------------------------------------ refundOutcome */

describe("refundOutcome", () => {
  const split = splitHeldMoney(
    [held("card", 100, "2026-07-01T10:00:00Z"), held("bank_transfer", 350, "2026-07-10T10:00:00Z")],
    1400,
  );

  it("filled (re-booked) → everything refunds, nothing retained", () => {
    const out = refundOutcome("filled", split);
    expect(out.refundTotal).toBe(450);
    expect(out.retainTotal).toBe(0);
    expect(out.byRail.card).toEqual({ refund: 100, retain: 0 });
    expect(out.byRail.bank_transfer).toEqual({ refund: 350, retain: 0 });
  });

  it("not_filled → conditional retained per rail, unconditional refunds regardless", () => {
    const out = refundOutcome("not_filled", split);
    expect(out.retainTotal).toBe(350);
    expect(out.refundTotal).toBe(100);
    expect(out.byRail.card).toEqual({ refund: 0, retain: 100 });
    expect(out.byRail.bank_transfer).toEqual({ refund: 100, retain: 250 });
    // Per-payment mirror for the /refunds execute view.
    expect(out.perPayment.map((p) => ({ refund: p.refund, retain: p.retain }))).toEqual([
      { refund: 0, retain: 100 },
      { refund: 100, retain: 250 },
    ]);
  });

  it("refund + retain always reconstruct the held total", () => {
    for (const det of ["filled", "not_filled"] as const) {
      const out = refundOutcome(det, split);
      expect(Math.round((out.refundTotal + out.retainTotal) * 100)).toBe(
        Math.round(split.total * 100),
      );
    }
  });
});

/* --------------------------------------------------------------- references */

describe("commitmentReference", () => {
  it("is quote-derived and distinct from the deposit/balance pair (orphan adoption never confuses them)", () => {
    expect(commitmentReference("MMR001")).toBe("MMR001-COM");
    const refs = [depositReference("X"), balanceReference("X"), commitmentReference("X")];
    expect(new Set(refs).size).toBe(3);
  });
});

/* ---------------------------------------------------- date-confirmation ack */

describe("DATE_CONFIRM_ACKS (PRD §5A)", () => {
  it("is a single ack whose key survives normalisation round-trip", () => {
    expect(DATE_CONFIRM_ACKS).toHaveLength(1);
    expect(allDateConfirmAcksConfirmed({ date_confirm: true })).toBe(true);
    expect(allDateConfirmAcksConfirmed({ date_confirm: "yes" })).toBe(false);
    expect(allDateConfirmAcksConfirmed(null)).toBe(false);
    expect(normalizeDateConfirmAcks({ date_confirm: true, extra: true })).toEqual({
      date_confirm: true,
    });
  });

  it("never says the forbidden word — held/retained framing only", () => {
    for (const ack of DATE_CONFIRM_ACKS) {
      expect(ack.label.toLowerCase()).not.toContain("penalty");
    }
  });

  it("states the load-bearing policy facts verbatim", () => {
    const label = DATE_CONFIRM_ACKS[0].label;
    expect(label).toContain("non-refundable");
    expect(label).toContain("within 7 days");
    expect(label).toContain("25%");
    expect(label).toContain("refunded in full if the day is re-booked");
  });
});

/* ------------------------------------------- gate 8: residential vs commercial */

describe("resolvePaymentPolicy", () => {
  it("reads a flagged client as commercial", () => {
    expect(resolvePaymentPolicy({ is_company: true })).toBe("commercial");
  });

  it("reads an unflagged client as residential", () => {
    expect(resolvePaymentPolicy({ is_company: false })).toBe("residential");
  });

  it("falls to residential — the collect-up-front direction — on anything unknown", () => {
    // Never guess "commercial": that hands out payment terms and switches off
    // the chase, and the queue that would have shown the mistake is the one the
    // guess just emptied. Guessing residential only asks a company for a
    // deposit, which is a conversation rather than a loss.
    expect(resolvePaymentPolicy({ is_company: null })).toBe("residential");
    expect(resolvePaymentPolicy({})).toBe("residential");
    expect(resolvePaymentPolicy(null)).toBe("residential");
    expect(resolvePaymentPolicy(undefined)).toBe("residential");
  });

  it("does not accept a truthy non-true value as commercial", () => {
    // Guards a stringly-typed read (PostgREST returning "true"/"f") from
    // silently promoting a residential client onto account terms.
    expect(resolvePaymentPolicy({ is_company: "true" } as never)).toBe("residential");
    expect(resolvePaymentPolicy({ is_company: 1 } as never)).toBe("residential");
  });
});

describe("policyOfQuote", () => {
  it("reads the snapshot when one was taken", () => {
    expect(policyOfQuote({ payment_policy: "commercial" })).toBe("commercial");
    expect(policyOfQuote({ payment_policy: "residential" })).toBe("residential");
  });

  it("reads every not-snapshotted shape as residential", () => {
    // Three legitimate sources of null: an unaccepted quote, a quote accepted
    // in the window between migration 0111 and the deploy that writes the
    // column, and an unreadable client row at acceptance. All three mean the
    // booking runs the ladder every Marley booking has always run.
    expect(policyOfQuote({ payment_policy: null })).toBe("residential");
    expect(policyOfQuote({})).toBe("residential");
    expect(policyOfQuote(null)).toBe("residential");
    expect(policyOfQuote(undefined)).toBe("residential");
  });

  it("never reads an unrecognised value as commercial", () => {
    expect(policyOfQuote({ payment_policy: "COMMERCIAL" })).toBe("residential");
    expect(policyOfQuote({ payment_policy: "business" })).toBe("residential");
  });
});

describe("paymentTermsDays", () => {
  it("passes through the two values the office can pick", () => {
    expect(paymentTermsDays(30)).toBe(30);
    expect(paymentTermsDays(60)).toBe(60);
  });

  it("coerces anything else to the 30-day default", () => {
    // The DB check constraint rejects these on write; this guards the READ
    // side, so a legacy null can never reach a due-date calculation as NaN and
    // silently produce an invoice due in 1970.
    expect(paymentTermsDays(null)).toBe(DEFAULT_PAYMENT_TERMS_DAYS);
    expect(paymentTermsDays(undefined)).toBe(DEFAULT_PAYMENT_TERMS_DAYS);
    expect(paymentTermsDays(45)).toBe(DEFAULT_PAYMENT_TERMS_DAYS);
    expect(paymentTermsDays(0)).toBe(DEFAULT_PAYMENT_TERMS_DAYS);
    expect(paymentTermsDays(Number.NaN)).toBe(DEFAULT_PAYMENT_TERMS_DAYS);
  });
});

describe("paymentTermsDueDate", () => {
  it("adds the client's terms to the day the invoice was raised", () => {
    expect(paymentTermsDueDate("2026-09-01T10:00:00Z", 30)).toBe("2026-10-01");
    expect(paymentTermsDueDate("2026-09-01T10:00:00Z", 60)).toBe("2026-10-31");
  });

  it("counts UK calendar days, so a late-evening BST instant is already tomorrow", () => {
    // 23:30 UTC on 1 Sept is 00:30 on the 2nd in London — the invoice is dated
    // the 2nd, so its terms run from the 2nd.
    expect(paymentTermsDueDate("2026-09-01T23:30:00Z", 30)).toBe("2026-10-02");
  });

  it("crosses the BST→GMT boundary without dropping or gaining a day", () => {
    // 2026 clocks go back on 25 October; 30 days from 10 Oct is 9 Nov either side.
    expect(paymentTermsDueDate("2026-10-10T12:00:00Z", 30)).toBe("2026-11-09");
  });

  it("falls back to the default terms rather than producing a nonsense date", () => {
    expect(paymentTermsDueDate("2026-09-01T10:00:00Z", null)).toBe("2026-10-01");
    expect(paymentTermsDueDate("2026-09-01T10:00:00Z", 45)).toBe("2026-10-01");
  });
});

describe("gate 8 leaves the residential ladder alone", () => {
  // The PRD's headline property, asserted here rather than assumed. If any of
  // these move, gate 8 has stopped being a foundation gate.
  it("still asks the plain deposit outside the commitment window", () => {
    const today = new Date("2026-09-01T09:00:00Z");
    expect(requestedDeposit(2000, 100, "2026-10-01", NO_SMALL_JOB, today)).toBe(100);
  });

  it("still collapses to 25% inside the commitment window", () => {
    const today = new Date("2026-09-01T09:00:00Z");
    expect(requestedDeposit(2000, 100, "2026-09-04", NO_SMALL_JOB, today)).toBe(500);
  });

  it("still computes the commitment as 25% of gross minus the deposit", () => {
    expect(commitmentAmount(2000, 100)).toBe(400);
  });
});

/* ------------------------------------ gate 9a: the small job takes one payment */

describe("requestedDeposit — the small-job full ask", () => {
  const today = new Date("2026-08-05T10:00:00Z");
  const THRESHOLD = 300; // the Settings default (Peter, 2026-08-25)

  it("kills the 2026-08-24 case: a £120 job asks £120 once, not £100 then £20", () => {
    const ask = requestedDeposit(120, 100, "2026-09-30", THRESHOLD, today);
    expect(ask).toBe(120);
    // The whole point: nothing is left to invoice afterwards.
    expect(commitmentAmount(120, ask)).toBe(0);
  });

  it("is inclusive at the threshold — £300 asks £300", () => {
    // This overrides a pre-gate-9a expectation on purpose. The old suite locked
    // `requestedDeposit(300, 100, …) === 100` as "25% never lowers the ask",
    // which was right when £100-then-£200-later was the only option. A £300 job
    // is now a small job, and asking for it once is the entire feature.
    expect(requestedDeposit(300, 100, "2026-08-10", THRESHOLD, today)).toBe(300);
  });

  it("leaves the job one penny above the threshold on the normal ladder", () => {
    expect(requestedDeposit(300.01, 100, "2026-09-30", THRESHOLD, today)).toBe(100);
  });

  it("never asks for more than the job costs", () => {
    // An £80 job with the £100 default: the ask is the job. True via the
    // small-job rule here...
    expect(requestedDeposit(80, 100, "2026-09-30", THRESHOLD, today)).toBe(80);
    // ...and true via the cap alone, with the rule switched off entirely.
    expect(requestedDeposit(80, 100, "2026-09-30", NO_SMALL_JOB, today)).toBe(80);
    // ...and true against an office-typed override well above the job.
    expect(requestedDeposit(250, 400, "2026-09-30", THRESHOLD, today)).toBe(250);
  });

  it("beats the late-booking collapse when a job is both small and imminent", () => {
    // £200 moving in two days. The late rule alone would ask max(100, £50) =
    // £100 and leave a £100 balance chasing a customer who moves on Friday.
    // The small-job rule asks the whole £200 and closes the ladder.
    const ask = requestedDeposit(200, 100, "2026-08-07", THRESHOLD, today);
    expect(ask).toBe(200);
    expect(commitmentAmount(200, ask)).toBe(0);
  });

  it("is switched off by a zero threshold, restoring the plain ladder", () => {
    expect(requestedDeposit(120, 100, "2026-09-30", 0, today)).toBe(100);
    expect(requestedDeposit(300, 100, "2026-08-10", 0, today)).toBe(100);
  });

  it("does not collapse a quote that has no price yet", () => {
    // gross 0 is "not priced", not "free". Reporting "pay the whole thing" for
    // a £0 quote would ask for nothing and silently end the ladder.
    expect(requestedDeposit(0, 100, "2026-09-30", THRESHOLD, today)).toBe(100);
  });

  it("leaves a normal job completely untouched", () => {
    // The assertion that matters most: the ordinary four-figure move that is
    // almost every booking sees none of this.
    expect(requestedDeposit(2000, 100, "2026-10-01", THRESHOLD, today)).toBe(100);
    expect(requestedDeposit(2000, 100, "2026-08-09", THRESHOLD, today)).toBe(500);
  });
});
