import { describe, expect, it } from "vitest";
import { buildUpcoming, mondayOf, type UpcomingSignal } from "@/lib/payments/upcoming";

const signal = (over: Partial<UpcomingSignal>): UpcomingSignal => ({
  quoteId: "q1",
  quoteRef: "MMR001",
  leadId: "l1",
  customer: "Jane Smith",
  bucket: "all_set",
  legacy: false,
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
