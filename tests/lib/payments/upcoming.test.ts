import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildUpcoming, mondayOf, type UpcomingSignal } from "@/lib/payments/upcoming";

const signal = (over: Partial<UpcomingSignal>): UpcomingSignal => ({
  quoteId: "q1",
  quoteRef: "MMR001",
  leadId: "l1",
  customer: "Jane Smith",
  bucket: "all_set",
  legacy: false,
  paymentPolicy: "residential",
  commercialDueDate: null,
  commitmentInvoiceAmount: 0,
  commitmentPaidAt: null,
  commitmentDueDate: null,
  balanceAmount: 0,
  balancePaidAt: null,
  moveDayUk: null,
  approxWindow: null,
  approxMonth: null,
  provisionalDate: null,
  ...over,
});

// Saturday 15 Aug 2026 → weeks run Mon 10 Aug … Sun 6 Sep.
const TODAY = "2026-08-15";

describe("mondayOf", () => {
  it("finds the Monday of any day (Mon–Sun weeks)", () => {
    expect(mondayOf("2026-08-15")).toBe("2026-08-10"); // Saturday
    expect(mondayOf("2026-08-10")).toBe("2026-08-10"); // Monday is its own start
    expect(mondayOf("2026-08-16")).toBe("2026-08-10"); // Sunday still belongs to the week
  });
});

describe("buildUpcoming", () => {
  it("dates a raised unpaid 25% by its due date and a booked balance by move day", () => {
    const view = buildUpcoming(
      [
        signal({
          quoteId: "qA",
          commitmentInvoiceAmount: 300,
          commitmentDueDate: "2026-08-20", // week 2
          balanceAmount: 900,
          moveDayUk: "2026-08-27", // week 3
        }),
      ],
      TODAY,
    );
    expect(view.weeks[1].items).toMatchObject([{ kind: "commitment", amount: 300, dueDay: "2026-08-20" }]);
    expect(view.weeks[2].items).toMatchObject([{ kind: "balance", amount: 900, dueDay: "2026-08-27" }]);
    expect(view.weeks[1].total).toBe(300);
    expect(view.weeks[2].total).toBe(900);
    expect(view.horizonStart).toBe("2026-08-10");
    expect(view.horizonEnd).toBe("2026-09-06");
  });

  it("paid money never appears; £0 balances never appear", () => {
    const view = buildUpcoming(
      [
        signal({ commitmentInvoiceAmount: 300, commitmentPaidAt: "2026-08-01T00:00:00Z", commitmentDueDate: "2026-08-20" }),
        signal({ quoteId: "q2", balanceAmount: 900, balancePaidAt: "2026-08-01T00:00:00Z", moveDayUk: "2026-08-27" }),
        signal({ quoteId: "q3", balanceAmount: 0, moveDayUk: "2026-08-27" }),
      ],
      TODAY,
    );
    expect(view.weeks.every((w) => w.items.length === 0)).toBe(true);
  });

  it("inside-current-week but past days flag overdue; before Monday they belong to the Due tab", () => {
    const view = buildUpcoming(
      [
        // Moved Thursday (13th), balance unpaid — still this week, overdue.
        signal({ quoteId: "qA", balanceAmount: 450, moveDayUk: "2026-08-13" }),
        // Moved LAST week — Due tab territory, not upcoming.
        signal({ quoteId: "qB", balanceAmount: 999, moveDayUk: "2026-08-07" }),
      ],
      TODAY,
    );
    expect(view.weeks[0].items).toMatchObject([{ quoteId: "qA", overdue: true }]);
    expect(view.weeks.flatMap((w) => w.items).some((i) => i.quoteId === "qB")).toBe(false);
  });

  it("money beyond the horizon is summarised, not itemised", () => {
    const view = buildUpcoming([signal({ balanceAmount: 2000, moveDayUk: "2026-09-21" })], TODAY);
    expect(view.weeks.every((w) => w.items.length === 0)).toBe(true);
    expect(view.beyond).toEqual({ count: 1, total: 2000 });
  });

  it("a booking can put BOTH its 25% and its balance on the board — they partition the price", () => {
    const view = buildUpcoming(
      [
        signal({
          commitmentInvoiceAmount: 200,
          commitmentDueDate: "2026-08-18",
          balanceAmount: 700,
          moveDayUk: "2026-08-25",
        }),
      ],
      TODAY,
    );
    const all = view.weeks.flatMap((w) => w.items);
    expect(all.map((i) => [i.kind, i.amount])).toEqual([
      ["commitment", 200],
      ["balance", 700],
    ]);
  });

  it("deposit-paid, no committed date → pencilled pipeline with the captured window", () => {
    const view = buildUpcoming(
      [
        signal({
          quoteId: "qP",
          bucket: "provisional",
          balanceAmount: 1100,
          approxWindow: "early",
          approxMonth: "2026-09-01",
        }),
        signal({ quoteId: "qN", bucket: "no_date", balanceAmount: 500 }),
      ],
      TODAY,
      4,
    );
    expect(view.pencilled.total).toBe(1600);
    expect(view.pencilled.items[0]).toMatchObject({ quoteId: "qP", amount: 1100 });
    expect(view.pencilled.items[0].windowLabel).toContain("Beginning of September");
    expect(view.pencilled.items[1]).toMatchObject({ quoteId: "qN", windowLabel: null });
  });
});

/**
 * The commercial ladder on the forecast board.
 *
 * Commercial money is dated by the CLIENT'S TERMS, not by the move day. The
 * board used to date it on the move day and flag it overdue the morning after,
 * because a commercial row reaches `buildUpcoming` looking exactly like a
 * residential one that owes everything: `depositOfQuote` returns 0 for
 * commercial and its `commitment_invoice_amount` is 0, so `balanceAmount` is
 * the whole agreed price and the only date in the projection was the move.
 *
 * For a client on 30-day terms whose job runs on the 1st, that put the money in
 * the wrong week AND printed OVERDUE on the 2nd against an invoice that is
 * genuinely in terms — a false alarm on the surface whose whole job is to be
 * believed. The weekly forecast was wrong for every commercial job on the board.
 *
 * The verdict is NOT recomputed here. `overdue` reads the bucket
 * `classifyBooking` already assigned, so the board, the /bookings queue and the
 * `commercial:invoice-overdue` ops alarm cannot drift into three different
 * definitions of "late" (lib/ops/commercial-overdue.ts — one classifier, three
 * surfaces).
 */
describe("buildUpcoming — the commercial ladder", () => {
  const commercial = (over: Partial<UpcomingSignal>): UpcomingSignal =>
    signal({ paymentPolicy: "commercial", ...over });

  it("dates the completion invoice on the client's terms, never on the move day", () => {
    // Job ran 13 Aug, invoice raised at completion, 20-day terms → 2 Sep
    // (week 4). The move day is in the PAST, so the old code both put the money
    // in the wrong place and called it late.
    const view = buildUpcoming(
      [
        commercial({
          quoteId: "qC",
          quoteRef: "MMC010",
          bucket: "commercial_invoiced",
          balanceAmount: 2400,
          moveDayUk: "2026-08-13",
          commercialDueDate: "2026-09-02",
        }),
      ],
      TODAY,
    );
    expect(view.weeks[3].items).toMatchObject([
      // Its own kind, not `balance`: the row's caption is drawn from it, and
      // "due in full by move day" would be the same wrong event in words.
      { kind: "commercial", amount: 2400, dueDay: "2026-09-02", overdue: false },
    ]);
    // The move day must appear nowhere on the board — not as a date, not as a
    // week. This is the assertion that fails the moment anybody reintroduces
    // move-day dating for commercial.
    const all = view.weeks.flatMap((w) => w.items);
    expect(all.map((i) => i.dueDay)).toEqual(["2026-09-02"]);
    expect(view.weeks[0].items).toEqual([]);
  });

  it("flags overdue only once the client's terms have passed", () => {
    // Job ran 14 Jul, 30-day terms → due Thu 13 Aug, two days ago: still this
    // week, and genuinely late. The old code dropped this row from the board
    // entirely, because its move day fell before the horizon's Monday.
    const view = buildUpcoming(
      [
        commercial({
          quoteId: "qC",
          bucket: "commercial_overdue",
          balanceAmount: 1500,
          moveDayUk: "2026-07-14",
          commercialDueDate: "2026-08-13",
        }),
      ],
      TODAY,
    );
    expect(view.weeks[0].items).toMatchObject([
      { quoteId: "qC", dueDay: "2026-08-13", overdue: true, amount: 1500 },
    ]);
  });

  it("due TODAY is not overdue — the client has the whole of the terms date", () => {
    // The boundary the `<` in `classifyCommercial` draws. An invoice due today
    // is in terms until midnight; calling it late is the same false alarm one
    // day earlier.
    const view = buildUpcoming(
      [
        commercial({
          quoteId: "qC",
          bucket: "commercial_invoiced",
          balanceAmount: 900,
          moveDayUk: "2026-07-16",
          commercialDueDate: TODAY,
        }),
      ],
      TODAY,
    );
    expect(view.weeks[0].items).toMatchObject([{ dueDay: TODAY, overdue: false }]);
  });

  it("an invoice with NO terms date is never dated, never overdue, and never dropped", () => {
    // `!!date && date < today` reads a missing date as false, which renders as
    // "in terms" — the reassuring answer produced by having no information at
    // all. So a missing terms date gets no date and no verdict, and the money
    // goes to its own undated list where the office can see the gap. Silently
    // omitting it would be the same lie one surface further out: this board's
    // way of saying "nothing to report" about a check it could not make.
    const view = buildUpcoming(
      [
        commercial({
          quoteId: "qC",
          bucket: "commercial_terms_unknown",
          balanceAmount: 1800,
          moveDayUk: "2026-08-27",
          commercialDueDate: null,
        }),
      ],
      TODAY,
    );
    expect(view.weeks.flatMap((w) => w.items)).toEqual([]);
    expect(view.beyond).toEqual({ count: 0, total: 0 });
    expect(view.commercialUndated.total).toBe(1800);
    expect(view.commercialUndated.items[0]).toMatchObject({ quoteId: "qC", amount: 1800 });
    expect(view.commercialUndated.items[0].reason).toContain("terms date");
  });

  it("a booked commercial job awaiting completion is undated too, and says so distinctly", () => {
    // Normal state, not a defect: the invoice raises when the job is done. It
    // still carries no date, so it cannot go in a week — but it must not share
    // a rendering with the terms-date gap above, which needs somebody to act.
    // One reason is "wait", the other is "fix"; a single label for both hides
    // the defect behind the ordinary case.
    const view = buildUpcoming(
      [
        commercial({
          quoteId: "qW",
          bucket: "commercial_awaiting_completion",
          balanceAmount: 3000,
          moveDayUk: "2026-08-27",
        }),
        commercial({
          quoteId: "qU",
          bucket: "commercial_terms_unknown",
          balanceAmount: 1800,
          moveDayUk: "2026-08-20",
        }),
      ],
      TODAY,
    );
    expect(view.weeks.flatMap((w) => w.items)).toEqual([]);
    expect(view.commercialUndated.total).toBe(4800);
    const reasons = Object.fromEntries(view.commercialUndated.items.map((i) => [i.quoteId, i.reason]));
    expect(reasons.qW).toContain("completion");
    expect(reasons.qW).not.toBe(reasons.qU);
  });

  it("a settled commercial invoice appears nowhere at all", () => {
    const view = buildUpcoming(
      [
        commercial({
          bucket: "all_set",
          balanceAmount: 2400,
          balancePaidAt: "2026-08-14T10:00:00Z",
          moveDayUk: "2026-08-27",
          commercialDueDate: "2026-09-02",
        }),
      ],
      TODAY,
    );
    expect(view.weeks.flatMap((w) => w.items)).toEqual([]);
    expect(view.commercialUndated.items).toEqual([]);
    expect(view.beyond).toEqual({ count: 0, total: 0 });
  });

  it("terms falling beyond the horizon are summarised, like any other dated money", () => {
    const view = buildUpcoming(
      [
        commercial({
          bucket: "commercial_invoiced",
          balanceAmount: 5000,
          moveDayUk: "2026-08-25",
          commercialDueDate: "2026-10-24", // 60-day terms
        }),
      ],
      TODAY,
    );
    expect(view.weeks.flatMap((w) => w.items)).toEqual([]);
    expect(view.beyond).toEqual({ count: 1, total: 5000 });
  });
});

/**
 * The residential ladder is the strongest invariant in this project, so it is
 * asserted rather than assumed. These two cases were green BEFORE the
 * commercial fix and must stay green after it: the fix is allowed to add a
 * branch, never to move a residential pound.
 */
describe("buildUpcoming — residential is untouched", () => {
  it("still dates the balance on move day, and ignores a stray terms date", () => {
    // The terms date is deliberately populated on a RESIDENTIAL row. Routing is
    // by the snapshotted policy, not by which columns happen to be filled — a
    // residential booking must keep move-day dating even if something upstream
    // writes commercial_due_date to it.
    const view = buildUpcoming(
      [
        signal({
          quoteId: "qR",
          paymentPolicy: "residential",
          bucket: "balance_due",
          balanceAmount: 900,
          moveDayUk: "2026-08-27",
          commercialDueDate: "2026-12-01",
        }),
      ],
      TODAY,
    );
    expect(view.weeks[2].items).toMatchObject([{ kind: "balance", amount: 900, dueDay: "2026-08-27" }]);
    expect(view.weeks.flatMap((w) => w.items).map((i) => i.dueDay)).toEqual(["2026-08-27"]);
    expect(view.commercialUndated.items).toEqual([]);
  });

  it("keeps the 25% on its own due date and the move-day overdue rule", () => {
    const view = buildUpcoming(
      [
        signal({
          quoteId: "qR",
          bucket: "commitment_due",
          commitmentInvoiceAmount: 300,
          commitmentDueDate: "2026-08-20",
          balanceAmount: 900,
          moveDayUk: "2026-08-13", // moved Thursday, unpaid → overdue, as before
        }),
      ],
      TODAY,
    );
    expect(view.weeks[0].items).toMatchObject([{ kind: "balance", dueDay: "2026-08-13", overdue: true }]);
    expect(view.weeks[1].items).toMatchObject([{ kind: "commitment", dueDay: "2026-08-20", overdue: false }]);
  });

  it("an absent policy is residential — every booking before gate 8 ran that ladder", () => {
    // Same default direction as load-signals and resolvePaymentPolicy. Guessing
    // commercial would silently stop dating a residential balance on move day.
    const view = buildUpcoming(
      [signal({ paymentPolicy: null, balanceAmount: 750, moveDayUk: "2026-08-27" })],
      TODAY,
    );
    expect(view.weeks[2].items).toMatchObject([{ kind: "balance", amount: 750, dueDay: "2026-08-27" }]);
  });
});

/**
 * The wiring, asserted at the source. `UpcomingTab` is a server component that
 * needs the whole Supabase stack to run, so the property worth protecting is
 * not the arithmetic above but that the two fields the fix depends on actually
 * REACH it. Drop either from the projection and every commercial row silently
 * re-reads as residential — the exact defect, restored, with all the unit tests
 * above still green because they hand `buildUpcoming` its input directly.
 */
describe("the /payments Upcoming projection carries the commercial fields", () => {
  it("passes the snapshotted policy and the terms date through to buildUpcoming", () => {
    const src = readFileSync(join(process.cwd(), "app/(dashboard)/payments/upcoming-tab.tsx"), "utf8");
    expect(src).toContain("paymentPolicy: r.paymentPolicy");
    expect(src).toContain("commercialDueDate: r.commercialDueDate");
  });
});
