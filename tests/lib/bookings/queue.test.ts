import { describe, expect, it } from "vitest";
import {
  classifyBooking,
  daysBetweenUk,
  owedNow,
  queueMoney,
  type QueueSignals,
} from "@/lib/bookings/queue";

const TODAY = "2026-07-30";

const base: QueueSignals = {
  depositPaidAt: "2026-07-01T10:00:00Z",
  hasRemovalAppt: false,
  apptDayUk: null,
  provisionalDate: null,
  approxWindow: null,
  approxMonth: null,
  commitmentPaidAt: null,
  commitmentInvoiceAmount: null,
  commitmentDueDate: null,
  dateReleasableAt: null,
  balancePaidAt: null,
  balanceInvoiceNumber: null,
};

describe("classifyBooking", () => {
  it("unpaid deposit always wins, whatever else is set", () => {
    expect(classifyBooking({ ...base, depositPaidAt: null, hasRemovalAppt: true, apptDayUk: "2026-08-10" }, TODAY)).toBe(
      "deposit_outstanding",
    );
  });

  it("deposit paid with nothing pencilled = no_date; any window signal = provisional", () => {
    expect(classifyBooking(base, TODAY)).toBe("no_date");
    expect(classifyBooking({ ...base, approxWindow: "mid-August" }, TODAY)).toBe("provisional");
    expect(classifyBooking({ ...base, approxMonth: "2026-08-01" }, TODAY)).toBe("provisional");
    expect(classifyBooking({ ...base, provisionalDate: "2026-08-14" }, TODAY)).toBe("provisional");
    expect(classifyBooking({ ...base, approxWindow: "   " }, TODAY)).toBe("no_date");
  });

  const booked: QueueSignals = { ...base, hasRemovalAppt: true, apptDayUk: "2026-08-20" };

  it("unpaid 25% buckets by due date; the T-7 flag always means overdue", () => {
    const owed = { ...booked, commitmentInvoiceAmount: 450 };
    expect(classifyBooking({ ...owed, commitmentDueDate: "2026-08-05" }, TODAY)).toBe("commitment_due");
    expect(classifyBooking({ ...owed, commitmentDueDate: "2026-07-29" }, TODAY)).toBe("commitment_overdue");
    expect(classifyBooking({ ...owed, dateReleasableAt: "2026-07-28T09:00:00Z" }, TODAY)).toBe("commitment_overdue");
    // due today is not overdue yet
    expect(classifyBooking({ ...owed, commitmentDueDate: TODAY }, TODAY)).toBe("commitment_due");
  });

  it("a paid (or never-raised) 25% falls through to the balance lifecycle", () => {
    expect(classifyBooking({ ...booked, commitmentInvoiceAmount: 450, commitmentPaidAt: "2026-07-20T09:00:00Z" }, TODAY)).toBe(
      "all_set",
    );
    expect(classifyBooking({ ...booked, commitmentInvoiceAmount: 0 }, TODAY)).toBe("all_set");
  });

  it("balance: overdue after move day, due when invoiced or inside the window, else all set", () => {
    expect(classifyBooking({ ...booked, apptDayUk: "2026-07-28" }, TODAY)).toBe("balance_overdue");
    expect(classifyBooking({ ...booked, balanceInvoiceNumber: "INV-000210" }, TODAY)).toBe("balance_due");
    expect(classifyBooking({ ...booked, apptDayUk: "2026-08-01" }, TODAY)).toBe("balance_due"); // 2 days out
    expect(classifyBooking(booked, TODAY)).toBe("all_set"); // 21 days out, not invoiced
    expect(classifyBooking({ ...booked, apptDayUk: "2026-07-28", balancePaidAt: "2026-07-28T18:00:00Z" }, TODAY)).toBe(
      "all_set",
    );
  });
});

describe("classifyBooking — a paid-in-full small job is all_set, not balance-chased", () => {
  /**
   * Gate 9a: at or under the small-job threshold the acceptance ask IS the
   * gross — commitment clamps to 0 and NO balance invoice ever raises, so
   * `balance_paid_at` never stamps. The classifier's balance rung read that
   * as "balance still unpaid" and bucketed a fully-collected job as
   * balance_due (inside the window) or balance_overdue (after the move),
   * chasing £0 forever. A known-zero balance with no invoice is a SETTLED
   * job; an issued invoice keeps its authority, and an ABSENT amount is
   * unknown and must keep today's behaviour (the silent direction would
   * empty a chase list).
   */
  const paidSmallJob: QueueSignals = {
    ...base,
    hasRemovalAppt: true,
    apptDayUk: "2026-08-01", // 2 days out — inside the balance window
    commitmentInvoiceAmount: 0,
    balanceAmount: 0,
    balanceInvoiceNumber: null,
  };

  it("inside the balance window with £0 remaining and no invoice → all_set", () => {
    expect(classifyBooking(paidSmallJob, TODAY)).toBe("all_set");
  });

  it("after move day with £0 remaining and no invoice → all_set, never balance_overdue", () => {
    expect(classifyBooking({ ...paidSmallJob, apptDayUk: "2026-07-28" }, TODAY)).toBe("all_set");
  });

  it("control: a residential job WITH a balance is byte-identical to today", () => {
    const withBalance = { ...paidSmallJob, balanceAmount: 1700 };
    expect(classifyBooking(withBalance, TODAY)).toBe("balance_due");
    expect(classifyBooking({ ...withBalance, apptDayUk: "2026-07-28" }, TODAY)).toBe("balance_overdue");
    expect(classifyBooking({ ...withBalance, balanceInvoiceNumber: "INV-000210" }, TODAY)).toBe("balance_due");
  });

  it("control: an ISSUED invoice keeps its authority even at £0 — never skipped", () => {
    expect(
      classifyBooking({ ...paidSmallJob, balanceInvoiceNumber: "INV-000210" }, TODAY),
    ).toBe("balance_due");
  });

  it("control: an ABSENT amount is unknown, which keeps today's behaviour", () => {
    const unknown = { ...paidSmallJob };
    delete (unknown as { balanceAmount?: number | null }).balanceAmount;
    expect(classifyBooking(unknown, TODAY)).toBe("balance_due");
    expect(classifyBooking({ ...unknown, apptDayUk: "2026-07-28" }, TODAY)).toBe("balance_overdue");
  });
});

describe("daysBetweenUk", () => {
  it("counts calendar days, negative for the past", () => {
    expect(daysBetweenUk("2026-07-30", "2026-08-01")).toBe(2);
    expect(daysBetweenUk("2026-07-30", "2026-07-30")).toBe(0);
    expect(daysBetweenUk("2026-07-30", "2026-07-28")).toBe(-2);
  });
});

/**
 * owedNow is the money the office can actually ask for today. It is separate
 * from classifyBooking on purpose: the bucket ladder puts a booking in exactly
 * one place, which used to let an unpaid deposit hide the balance on a job
 * moving the same week (QA-20260820-04). These tests pin the two rules Peter
 * set on 2026-08-20: deposits are never "owed now", and a job inside the
 * 7-day window owes its money.
 */
const owedBase = {
  commitmentInvoiceAmount: 0,
  commitmentPaidAt: null as string | null,
  commitmentDueDate: null as string | null,
  dateReleasableAt: null as string | null,
  balanceAmount: 1700,
  balancePaidAt: null as string | null,
  balanceInvoiceNumber: null as string | null,
  hasRemovalAppt: true,
  apptDayUk: "2026-08-20",
};

describe("owedNow", () => {
  it("NEVER counts the deposit — an unpaid deposit adds nothing to owed-now", () => {
    // Deposit state is not even an input: the only money here is the balance,
    // and it is outside the window, so nothing is owed today.
    const far = owedNow({ ...owedBase, apptDayUk: "2026-09-30" }, TODAY);
    expect(far.total).toBe(0);
  });

  it("counts the balance for a job inside the 7-day window", () => {
    const inWindow = owedNow({ ...owedBase, apptDayUk: "2026-08-05" }, "2026-08-01");
    expect(inWindow.balance).toBe(1700);
    expect(inWindow.total).toBe(1700);
    expect(inWindow.overdue).toBe(0);
  });

  it("still counts the balance when the deposit was never paid (the bug)", () => {
    // The ladder would call this booking deposit_outstanding and report £0
    // balance. The money is owed regardless of which rung is unpaid.
    const moveDay = owedNow({ ...owedBase, apptDayUk: "2026-08-01" }, "2026-08-01");
    expect(moveDay.total).toBe(1700);
  });

  it("treats a passed move day as overdue", () => {
    const past = owedNow({ ...owedBase, apptDayUk: "2026-07-25" }, TODAY);
    expect(past.balance).toBe(1700);
    expect(past.overdue).toBe(1700);
  });

  it("adds the invoiced 25% to the balance without double-counting", () => {
    // balanceAmount is already agreed − deposit − commitment, so the two sum
    // to everything outstanding after the deposit.
    const both = owedNow(
      { ...owedBase, commitmentInvoiceAmount: 450, apptDayUk: "2026-08-02" },
      "2026-08-01",
    );
    expect(both.commitment).toBe(450);
    expect(both.balance).toBe(1700);
    expect(both.total).toBe(2150);
  });

  it("owes nothing when there is no move behind the balance", () => {
    // The INFERRED case: nothing invoiced, so a balance would be implied by a
    // date window alone. A booking with no date owes nothing today, however
    // large the job. This guard stays exactly as it was.
    expect(owedNow({ ...owedBase, hasRemovalAppt: false, apptDayUk: null }, TODAY).total).toBe(0);
  });

  it("counts an INVOICED balance with no diary entry yet (gates 9b/9c)", () => {
    // Gate 9b raises the balance at acceptance for a move already inside T-7;
    // gate 9c raises it when the customer chooses to settle in full. Both fire
    // days before the office allocates a slot, so requiring a removal
    // appointment reported GBP 0 owed on the jobs moving soonest, on BOTH
    // money headlines at once. An issued invoice is owed on its own
    // authority: a document has been sent asking for it.
    const issued = owedNow(
      { ...owedBase, hasRemovalAppt: false, apptDayUk: null, balanceInvoiceNumber: "INV-000318" },
      TODAY,
    );
    expect(issued.balance).toBe(1700);
    expect(issued.total).toBe(1700);
    // Not past due: there is no move day to have passed.
    expect(issued.overdue).toBe(0);
  });

  it("mutating either half of the issued-balance clause changes the answer", () => {
    // Guard on the clause above: if these still returned 1700 the new
    // condition would be doing no work.
    expect(
      owedNow(
        {
          ...owedBase,
          hasRemovalAppt: false,
          apptDayUk: null,
          balanceInvoiceNumber: "INV-000318",
          balancePaidAt: "2026-07-29T10:00:00Z",
        },
        TODAY,
      ).total,
    ).toBe(0);
    expect(
      owedNow(
        { ...owedBase, hasRemovalAppt: false, apptDayUk: null, balanceInvoiceNumber: "INV-000318", balanceAmount: 0 },
        TODAY,
      ).total,
    ).toBe(0);
  });

  it("owes nothing once the money is paid", () => {
    expect(
      owedNow(
        { ...owedBase, apptDayUk: "2026-07-25", balancePaidAt: "2026-07-26T10:00:00Z" },
        TODAY,
      ).total,
    ).toBe(0);
    expect(
      owedNow(
        { ...owedBase, commitmentInvoiceAmount: 450, commitmentPaidAt: "2026-07-01T09:00:00Z", apptDayUk: "2026-09-30" },
        TODAY,
      ).total,
    ).toBe(0);
  });

  it("marks an invoiced 25% overdue once its due date passes, or the T-7 flag is set", () => {
    const late = owedNow(
      { ...owedBase, commitmentInvoiceAmount: 450, commitmentDueDate: "2026-07-20", apptDayUk: "2026-09-30" },
      TODAY,
    );
    expect(late.overdue).toBe(450);
    const flagged = owedNow(
      { ...owedBase, commitmentInvoiceAmount: 450, dateReleasableAt: "2026-07-29T00:00:00Z", apptDayUk: "2026-09-30" },
      TODAY,
    );
    expect(flagged.overdue).toBe(450);
  });
});

/**
 * queueMoney - the one seam behind every money headline on /bookings and
 * /payments Due. These assertions exist because the two pages once computed
 * the same money two different ways: the 25% tile summed the commitment_*
 * BUCKETS while everything else summed OBLIGATIONS, so an invoiced-and-unpaid
 * 25% on a booking the office had not yet put in the diary was counted by
 * /payments and not by /bookings (QA-20260826-01).
 */
const money = (
  bucket: string,
  deposit: number,
  owed: { commitment: number; balance: number; commitmentOverdue?: number; balanceOverdue?: number },
) => {
  // Overdue is stated per obligation, never as one lump: the 25% and the
  // balance are chased in different sections, so a combined figure cannot say
  // which list holds it. `overdue` is derived here rather than passed, so a
  // fixture can never claim a total its two halves do not add up to.
  const commitmentOverdue = owed.commitmentOverdue ?? 0;
  const balanceOverdue = owed.balanceOverdue ?? 0;
  return {
    bucket: bucket as never,
    deposit,
    owed: {
      commitment: owed.commitment,
      balance: owed.balance,
      total: owed.commitment + owed.balance,
      commitmentOverdue,
      balanceOverdue,
      overdue: commitmentOverdue + balanceOverdue,
    },
  };
};

describe("queueMoney", () => {
  it("counts an invoiced 25% the bucket ladder cannot reach", () => {
    // Date confirmed and the 25% raised, but the office has not booked the
    // slot - so classifyBooking says no_date and no commitment_* bucket holds
    // it. The tile must still show the money.
    const m = queueMoney([money("no_date", 0, { commitment: 450, balance: 0 })]);
    expect(m.commitment).toBe(450);
    expect(m.commitmentJobs).toBe(1);
    expect(m.owedNow).toBe(450);
  });

  it("counts an invoiced 25% behind an unpaid deposit too", () => {
    // ensureCommitmentInvoice requires a confirmed date and the customer's
    // signature - NOT a paid deposit - so this combination is reachable.
    const m = queueMoney([money("deposit_outstanding", 100, { commitment: 450, balance: 0, commitmentOverdue: 450 })]);
    expect(m.commitment).toBe(450);
    expect(m.overdue).toBe(450);
    // Split the way the sections are split, so the tile can name the list.
    expect(m.commitmentOverdue).toBe(450);
    expect(m.balanceOverdue).toBe(0);
    // The deposit is reported separately and never joins owedNow.
    expect(m.depositsOutstanding).toBe(100);
    expect(m.depositJobs).toBe(1);
    expect(m.owedNow).toBe(450);
  });

  it("totals a mix the bucket ladder gets wrong", () => {
    // The invariant that replaces the QA ledger's false one (Balance
    // outstanding matches Due exactly), which only ever held on a day with no
    // unpaid 25%. /bookings shows m.commitment and m.balance as two tiles and
    // /payments shows m.owedNow, and neither tile alone equals the headline.
    //
    // That the two tiles SUM to the headline is not asserted here: owedNow is
    // defined as commitment + balance a few lines up in queue.ts, so the
    // assertion would hold for every input, including one produced by the
    // bucket-based tile this whole block exists to forbid. The half of that
    // identity worth pinning is the arithmetic below; the half about which
    // figure each PAGE renders is pinned against the pages themselves in
    // tests/lib/bookings/bucket-coverage.test.ts.
    const rows = [
      money("no_date", 0, { commitment: 450, balance: 0 }),
      money("deposit_outstanding", 100, { commitment: 300, balance: 0, commitmentOverdue: 300 }),
      money("commitment_due", 0, { commitment: 500, balance: 0 }),
      money("balance_due", 0, { commitment: 0, balance: 1700 }),
      money("balance_overdue", 0, { commitment: 0, balance: 900, balanceOverdue: 900 }),
      money("all_set", 0, { commitment: 0, balance: 0 }),
    ];
    const m = queueMoney(rows);
    expect(m.commitment).toBe(1250);
    expect(m.balance).toBe(2600);
    expect(m.owedNow).toBe(3850);
    expect(m.overdue).toBe(1200);
    // And the overdue half splits the same way the danger sections do.
    expect(m.commitmentOverdue).toBe(300);
    expect(m.balanceOverdue).toBe(900);
    expect(m.commitmentOverdue + m.balanceOverdue).toBe(m.overdue);
    // Deposits are disjoint from every owed figure.
    expect(m.depositsOutstanding).toBe(100);

    // ...and the mix has to STAY one a bucket-based tile gets wrong, or £1,250
    // above could be satisfied by the very implementation this block forbids.
    // Two of the three unpaid 25%s sit in buckets no commitment_* filter
    // reaches, which is QA-20260826-01 exactly.
    const bucketBased = rows
      .filter((r) => (r.bucket as string).startsWith("commitment_"))
      .reduce((s, r) => s + r.owed.commitment, 0);
    expect(
      bucketBased,
      "the fixture stopped discriminating: every unpaid 25% now sits in a commitment_* bucket, " +
        "so a tile that summed those buckets would pass this test",
    ).toBeLessThan(m.commitment);
  });

  it("reads money per obligation, so re-bucketing a row cannot move it", () => {
    // The regression the fixture above is chosen to catch, stated directly:
    // any bucket-conditional money read. Same obligations, different rung —
    // every owed figure must be identical. Only the deposit figures are
    // bucket-keyed, deliberately (the deposits queue IS a bucket), and neither
    // row here is in it.
    const owed = { commitment: 450, balance: 1700, overdue: 450 };
    const parked = queueMoney([money("no_date", 0, owed)]);
    const booked = queueMoney([money("commitment_due", 0, owed)]);
    expect(parked).toEqual(booked);
    expect(parked.commitment).toBe(450);
    expect(parked.balance).toBe(1700);
    expect(parked.commitmentJobs).toBe(1);
  });

  it("a row owing the 25% AND an early balance counts in both tiles at once", () => {
    // Gate 9c: settling in full raises the balance alongside the unpaid 25%.
    // The bucket carries only half the story, which is why money is never
    // read off the bucket.
    const m = queueMoney([money("commitment_due", 0, { commitment: 400, balance: 1500 })]);
    expect(m.commitment).toBe(400);
    expect(m.balance).toBe(1500);
    expect(m.owedNow).toBe(1900);
    expect(m.commitmentJobs).toBe(1);
    // One row, both job counters — it is on two chase lists, not one.
    expect(m.balanceJobs).toBe(1);
  });

  it("a small job (gate 9a) contributes nothing to owed money", () => {
    // The full price was asked once at acceptance, so there is no 25% and no
    // balance for the rest of its life.
    const m = queueMoney([money("all_set", 0, { commitment: 0, balance: 0 })]);
    expect(m.owedNow).toBe(0);
    expect(m.commitmentJobs).toBe(0);
    expect(m.balanceJobs).toBe(0);
  });

  it("counts a commercial completion invoice, which reaches no balance_* bucket", () => {
    // The dashboard card read "No balances outstanding" against a live unpaid
    // commercial invoice, because it tested the two balance BUCKETS and the
    // commercial ladder never enters either of them.
    const m = queueMoney([money("commercial_invoiced", 0, { commitment: 0, balance: 2400 })]);
    expect(m.balance).toBe(2400);
    expect(m.balanceJobs).toBe(1);
    expect(m.owedNow).toBe(2400);
  });

  it("is empty for no rows", () => {
    expect(queueMoney([])).toEqual({
      depositsOutstanding: 0,
      depositJobs: 0,
      commitment: 0,
      commitmentJobs: 0,
      balance: 0,
      balanceJobs: 0,
      owedNow: 0,
      overdue: 0,
      commitmentOverdue: 0,
      balanceOverdue: 0,
    });
  });
});

/**
 * The commercial ladder (gate 10, PRD §3.10). A different schedule entirely:
 * no deposit, no 25%, no customer chase. One invoice raised when the job is
 * done, due on the client's own terms.
 *
 * The residential assertions above are the control. Every one of them still
 * passes because commercial is answered FIRST and never falls through - which
 * is the property that matters, since the PRD's headline promise is that
 * residential behaviour is unchanged.
 */
describe("classifyBooking — commercial", () => {
  const commercial: QueueSignals = {
    ...base,
    paymentPolicy: "commercial",
    // No deposit is ever taken on a commercial booking. Left null on purpose:
    // if the ladder ever fell through to the residential rungs this would park
    // it in deposit_outstanding, on a chase queue for money nobody agreed to
    // pay up front.
    depositPaidAt: null,
  };

  it("an unpaid deposit does NOT drag a commercial booking onto the deposit queue", () => {
    expect(classifyBooking(commercial, TODAY)).toBe("commercial_awaiting_completion");
  });

  it("stays awaiting until the completion invoice actually exists", () => {
    // Before the job is done, and after it is done but before the invoice is
    // raised, both read the same on the board - because in both states the
    // office has something outstanding to do and nothing has been asked for.
    const booked = { ...commercial, hasRemovalAppt: true, apptDayUk: "2026-08-20" };
    expect(classifyBooking(booked, TODAY)).toBe("commercial_awaiting_completion");
    expect(classifyBooking({ ...booked, jobCompleted: true }, TODAY)).toBe(
      "commercial_awaiting_completion",
    );
  });

  it("goes overdue on the CLIENT TERMS, not on the move date", () => {
    // The move being long past means nothing here: a 30-day-terms invoice
    // raised on completion is not late until day 31.
    const invoiced = {
      ...commercial,
      hasRemovalAppt: true,
      apptDayUk: "2026-07-01",
      jobCompleted: true,
      balanceInvoiceNumber: "INV-000401",
    };
    expect(classifyBooking({ ...invoiced, commercialDueDate: "2026-08-31" }, TODAY)).toBe(
      "commercial_invoiced",
    );
    expect(classifyBooking({ ...invoiced, commercialDueDate: "2026-07-29" }, TODAY)).toBe(
      "commercial_overdue",
    );
    // Due today is not overdue yet - same boundary as the residential rungs.
    expect(classifyBooking({ ...invoiced, commercialDueDate: TODAY }, TODAY)).toBe(
      "commercial_invoiced",
    );
  });

  it("an invoiced job with NO terms date is not reported as in terms", () => {
    // `!!date && date < today` reads a MISSING date as "not past" — the
    // reassuring answer, produced by having no information at all. Nothing
    // wrote commercial_due_date until the completion invoice started stamping
    // it, so every commercial invoice read as comfortably in terms forever and
    // the overdue state was unreachable code.
    //
    // "In terms" and "we cannot tell" are different answers and must not share
    // a rendering, so the undated invoice gets its own bucket and its own
    // section rather than being quietly filed with the healthy rows.
    const invoiced = {
      ...commercial,
      hasRemovalAppt: true,
      apptDayUk: "2026-07-01",
      jobCompleted: true,
      balanceInvoiceNumber: "INV-000401",
    };
    expect(classifyBooking({ ...invoiced, commercialDueDate: null }, TODAY)).toBe(
      "commercial_terms_unknown",
    );
    expect(classifyBooking(invoiced, TODAY)).toBe("commercial_terms_unknown");
  });

  it("an undated job that is not invoiced yet still reads as awaiting completion", () => {
    // The ordinary pre-invoice state. A terms date cannot exist before the
    // invoice it dates, so its absence there is expected and says nothing —
    // only an invoice with no date is a gap.
    expect(
      classifyBooking({ ...commercial, jobCompleted: true, commercialDueDate: null }, TODAY),
    ).toBe("commercial_awaiting_completion");
  });

  it("settles to all_set once paid", () => {
    expect(
      classifyBooking(
        {
          ...commercial,
          balanceInvoiceNumber: "INV-000401",
          commercialDueDate: "2026-07-01",
          balancePaidAt: "2026-07-05T10:00:00Z",
        },
        TODAY,
      ),
    ).toBe("all_set");
  });

  it("an absent or residential policy runs the residential ladder unchanged", () => {
    // The default direction matters: guessing commercial would switch a
    // booking's chase off silently.
    expect(classifyBooking({ ...base, depositPaidAt: null }, TODAY)).toBe("deposit_outstanding");
    expect(classifyBooking({ ...base, depositPaidAt: null, paymentPolicy: "residential" }, TODAY)).toBe(
      "deposit_outstanding",
    );
    expect(classifyBooking({ ...base, depositPaidAt: null, paymentPolicy: null }, TODAY)).toBe(
      "deposit_outstanding",
    );
  });
});

describe("owedNow — commercial", () => {
  const commercialOwed = {
    ...owedBase,
    paymentPolicy: "commercial" as const,
    balanceAmount: 2400,
    hasRemovalAppt: true,
  };

  it("owes NOTHING until the completion invoice is raised", () => {
    // There is no deposit and no 25%, so inventing an obligation from the
    // agreed price would put money on the /payments headline that nobody has
    // been asked for.
    const v = owedNow({ ...commercialOwed, balanceInvoiceNumber: null }, TODAY);
    expect(v.total).toBe(0);
    expect(v.commitment).toBe(0);
  });

  it("owes the whole invoice once raised, and never a commitment", () => {
    const v = owedNow(
      { ...commercialOwed, balanceInvoiceNumber: "INV-000401", commercialDueDate: "2026-08-31" },
      TODAY,
    );
    expect(v.balance).toBe(2400);
    expect(v.total).toBe(2400);
    // A commercial job has no 25% rung at all, even if a stale figure were
    // somehow present on the row.
    expect(
      owedNow(
        {
          ...commercialOwed,
          balanceInvoiceNumber: "INV-000401",
          commitmentInvoiceAmount: 999,
        },
        TODAY,
      ).commitment,
    ).toBe(0);
  });

  it("is overdue on the terms date, not the move date", () => {
    const late = owedNow(
      { ...commercialOwed, balanceInvoiceNumber: "INV-000401", commercialDueDate: "2026-07-20", apptDayUk: "2026-07-01" },
      TODAY,
    );
    expect(late.overdue).toBe(2400);
    const inTerms = owedNow(
      { ...commercialOwed, balanceInvoiceNumber: "INV-000401", commercialDueDate: "2026-08-31", apptDayUk: "2026-07-01" },
      TODAY,
    );
    // The move is a month past and it is still not late. That is the whole
    // point of commercial terms.
    expect(inTerms.overdue).toBe(0);
    expect(inTerms.total).toBe(2400);
  });

  it("an undated invoice counts in the total but is never ASSERTED overdue", () => {
    // Deliberately not the same treatment classifyBooking gives it, and the
    // difference is the point: `overdue` is a claim of fact about a date, and
    // with no date there is no fact to state. So the money is still counted —
    // never hidden from the headline — while the lateness claim is withheld,
    // and the row's own bucket is what puts the gap in front of the office.
    const v = owedNow(
      { ...commercialOwed, balanceInvoiceNumber: "INV-000401", commercialDueDate: null },
      TODAY,
    );
    expect(v.total).toBe(2400);
    expect(v.overdue).toBe(0);
  });

  it("a commercial job with no diary entry still owes its raised invoice", () => {
    // Same principle as the residential fix in QA-20260826-01: an ISSUED
    // invoice is owed on its own authority.
    const v = owedNow(
      {
        ...commercialOwed,
        hasRemovalAppt: false,
        apptDayUk: null,
        balanceInvoiceNumber: "INV-000401",
        commercialDueDate: "2026-08-31",
      },
      TODAY,
    );
    expect(v.total).toBe(2400);
  });
});
