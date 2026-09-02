import { describe, expect, it } from "vitest";
import {
  bookingChangeMode,
  buildCancellationAckEmailHtml,
  buildDateChangeConfirmationEmailHtml,
  buildMarleyCancelEmailHtml,
  CANCEL_CONFIRMED_WARNING,
  CANCEL_UNCONFIRMED_NOTE,
  cancellationAckSubject,
  cancellationAckTemplateVars,
  cancellationAckText,
  dateChangeConfirmationSubject,
  dateChangeConfirmationTemplateVars,
  dateChangeConfirmationText,
  heldLines,
  INSIDE_WINDOW_CHANGE_WARNING,
  MARLEY_CANCEL_NOTE,
  marleyCancelSubject,
  marleyCancelTemplateVars,
  marleyCancelText,
  queueAmountsFor,
} from "@/lib/comms/cancellation-emails";
import { splitHeldMoney, type HeldPayment } from "@/lib/payments-policy";
import { buildHeldFromSources } from "@/lib/refunds";

/**
 * Lane C pure surface (Payments Policy v2 §5C): the date-window routing the
 * change-date action branches on, the queue-row amount planning, and the three
 * customer email builders — all of which must show gross amounts and NEVER say
 * "penalty".
 */

/* --------------------------------------------------- date-window routing */

describe("bookingChangeMode — the 7-day boundary (UK calendar days)", () => {
  // 09:00 UTC on 1 July 2026 is 10:00 BST — UK day 2026-07-01.
  const today = new Date("2026-07-01T09:00:00Z");

  it("exactly 7 days out is OUTSIDE — a free reschedule", () => {
    expect(bookingChangeMode("2026-07-08", today)).toBe("reschedule");
  });

  it("6 days out is INSIDE — cancel-and-rebook", () => {
    expect(bookingChangeMode("2026-07-07", today)).toBe("cancel_rebook");
  });

  it("same-day and past moves are inside", () => {
    expect(bookingChangeMode("2026-07-01", today)).toBe("cancel_rebook");
    expect(bookingChangeMode("2026-06-30", today)).toBe("cancel_rebook");
  });

  it("a late-evening UTC instant is already tomorrow in UK summer time", () => {
    // 23:30Z on 1 July = 00:30 BST on 2 July → only 6 UK days to 8 July.
    const lateEvening = new Date("2026-07-01T23:30:00Z");
    expect(bookingChangeMode("2026-07-08", lateEvening)).toBe("cancel_rebook");
  });

  it("no old move day = no window to be inside (plain reschedule)", () => {
    expect(bookingChangeMode(null, today)).toBe("reschedule");
    expect(bookingChangeMode(undefined, today)).toBe("reschedule");
  });
});

/* -------------------------------------------------- queue amount planning */

const heldFixture: HeldPayment[] = [
  { rail: "bank_transfer", amount: 100, at: "2026-07-01T09:00:00Z", label: "deposit" },
  { rail: "bank_transfer", amount: 350, at: "2026-07-05T09:00:00Z", label: "commitment" },
];

describe("queueAmountsFor — retention only exists after date confirmation", () => {
  const split = splitHeldMoney(heldFixture, 1400); // cap £350

  it("confirmed → the 25%-cap split passes through", () => {
    expect(queueAmountsFor(split, true)).toEqual({ conditional: 350, unconditional: 100 });
  });

  it("unconfirmed → nothing is retainable; everything is unconditional", () => {
    expect(queueAmountsFor(split, false)).toEqual({ conditional: 0, unconditional: 450 });
  });

  it("snapshot → split → amounts chain (the queue-row numbers end to end)", () => {
    // The same chain markLeadLostAction / changeBookingDateAction run.
    const held = buildHeldFromSources({
      cardRows: [
        {
          id: "cp-1",
          status: "paid",
          amount_pence: 10000,
          refunded_pence: 0,
          is_test: false,
          kind: "deposit",
          settled_at: "2026-07-01T10:00:00Z",
          created_at: "2026-07-01T09:59:00Z",
        },
      ],
      quote: {
        id: "q-1",
        quote_ref: "MMR001",
        client_id: "c-1",
        customer_name: "Freddy Arbuthnot",
        agreed_price: 2400,
        grand_total: 2400,
        deposit_amount: 100,
        deposit_paid_at: "2026-07-01T10:00:00Z",
        deposit_paid_method: "card", // deduped against the card row
        commitment_invoice_amount: 500,
        commitment_paid_at: "2026-07-05T09:00:00Z",
        commitment_paid_method: "bank_transfer",
        balance_invoice_amount: null,
        zoho_deposit_invoice_id: null,
        zoho_commitment_invoice_id: "zoho-com-1",
        zoho_balance_invoice_id: null,
        deposit_invoice_provider: null,
        commitment_invoice_provider: "zoho",
        balance_invoice_provider: null,
      },
      lead: { id: "l-1", name: "Freddy", balance_paid_at: null, balance_amount: null },
    });
    const chainSplit = splitHeldMoney(held, 2400); // cap £600 > £600 held? cap = 600
    // £100 card + £500 bank = £600 held, cap £600 → all conditional when confirmed.
    expect(queueAmountsFor(chainSplit, true)).toEqual({ conditional: 600, unconditional: 0 });
    expect(queueAmountsFor(chainSplit, false)).toEqual({ conditional: 0, unconditional: 600 });
  });
});

describe("heldLines", () => {
  it("renders one gross display line per payment with its rail", () => {
    expect(heldLines(heldFixture)).toEqual([
      "£100 deposit by bank transfer",
      "£350 commitment by bank transfer",
    ]);
  });

  it("copes with unlabelled payments and card/cash rails", () => {
    expect(
      heldLines([
        { rail: "card", amount: 123.45, at: "2026-07-01" },
        { rail: "cash", amount: 50, at: "2026-07-02", label: "deposit" },
      ]),
    ).toEqual(["£123.45 by card", "£50 deposit by cash"]);
  });
});

/* -------------------------------------------------------- email builders */

const ackMeta = {
  firstName: "Freddy Arbuthnot",
  quoteRef: "MMR001",
  oldDateLabel: "Monday 20 July",
  newDateLabel: "Friday 24 July",
  heldTotal: 450,
  conditionalAmount: 350,
  unconditionalAmount: 100,
  heldLines: heldLines(heldFixture),
  dateConfirmed: true,
};

const marleyMeta = {
  firstName: "Freddy Arbuthnot",
  quoteRef: "MMR001",
  moveDateLabel: "Monday 20 July",
  refundTotal: 450,
  heldLines: heldLines(heldFixture),
};

const changeMeta = {
  firstName: "Freddy Arbuthnot",
  quoteRef: "MMR001",
  oldDateLabel: "Monday 20 July",
  newDateLabel: "Friday 14 August",
  heldTotal: 100,
  heldLines: ["£100 deposit by bank transfer"],
  commitmentAmount: 500,
  commitmentDueLabel: "Friday 7 August",
};

describe("cancellation-ack (inside-window date change)", () => {
  it("restates the held amounts gross with the fill rule and the refund SLA", () => {
    const html = buildCancellationAckEmailHtml(ackMeta);
    expect(html).toContain("£450");
    expect(html).toContain("£350");
    expect(html).toContain("Monday 20 July");
    expect(html).toContain("Friday 24 July");
    expect(html).toContain("re-book");
    expect(html).toContain("within 14 days");
    expect(html).toContain("No new deposit");
  });

  it("pre-confirmation framing: everything simply moves", () => {
    const html = buildCancellationAckEmailHtml({
      ...ackMeta,
      dateConfirmed: false,
      conditionalAmount: 0,
      unconditionalAmount: 450,
    });
    expect(html).toContain("simply moves with you");
    expect(html).not.toContain("may be retained");
  });

  it("text + template vars carry the same numbers", () => {
    const text = cancellationAckText(ackMeta);
    expect(text).toContain("£450");
    expect(text).toContain("£350");
    const vars = cancellationAckTemplateVars(ackMeta);
    // The card is a pre-composed fragment: full house-style card when money is
    // held, EMPTY when nothing was paid (a £0 card must never render).
    expect(vars.HELD_CARD).toContain("£450");
    expect(vars.HELD_CARD).toContain("Already paid");
    expect(vars.HELD_CARD).toContain("£100 deposit by bank transfer");
    expect(vars.QUOTE_REF).toBe("MMR001");
    expect(cancellationAckTemplateVars({ ...ackMeta, heldTotal: 0, heldLines: [] }).HELD_CARD).toBe("");
    expect(cancellationAckSubject(ackMeta)).toContain("MMR001");
  });

  it("escapes hostile names", () => {
    const html = buildCancellationAckEmailHtml({ ...ackMeta, firstName: "<script>alert(1)</script>" });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("marley-cancel (apology + full refund)", () => {
  it("promises everything back in full within the SLA", () => {
    const html = buildMarleyCancelEmailHtml(marleyMeta);
    expect(html).toContain("£450");
    expect(html).toContain("Refunded in full");
    expect(html).toContain("within 14 days");
    expect(html).toContain("sorry");
  });

  it("nothing-paid variant says nothing is owed", () => {
    const html = buildMarleyCancelEmailHtml({ ...marleyMeta, refundTotal: 0, heldLines: [] });
    expect(html).toContain("nothing owed");
    expect(html).not.toContain("Refunded in full");
  });

  it("text + template vars agree", () => {
    expect(marleyCancelText(marleyMeta)).toContain("£450");
    const vars = marleyCancelTemplateVars(marleyMeta);
    expect(vars.REFUND_CARD).toContain("£450");
    expect(vars.REFUND_CARD).toContain("Refunded in full");
    expect(marleyCancelTemplateVars({ ...marleyMeta, refundTotal: 0, heldLines: [] }).REFUND_CARD).toBe("");
    expect(marleyCancelSubject(marleyMeta)).toContain("MMR001");
  });
});

describe("date-change-confirmation (outside window)", () => {
  it("restates held money and the commitment due date", () => {
    const html = buildDateChangeConfirmationEmailHtml(changeMeta);
    expect(html).toContain("Friday 14 August");
    expect(html).toContain("£100");
    expect(html).toContain("£500");
    expect(html).toContain("Friday 7 August");
    expect(html).toContain("still counts towards your move");
  });

  it("omits the commitment sentence when nothing is due on that rung", () => {
    const html = buildDateChangeConfirmationEmailHtml({
      ...changeMeta,
      commitmentAmount: null,
      commitmentDueLabel: null,
    });
    expect(html).not.toContain("commitment payment");
  });

  it("text + template vars agree", () => {
    const text = dateChangeConfirmationText(changeMeta);
    expect(text).toContain("Friday 14 August");
    expect(text).toContain("£500");
    const vars = dateChangeConfirmationTemplateVars(changeMeta);
    expect(vars.NEW_DATE_LABEL).toBe("Friday 14 August");
    expect(vars.COMMITMENT_SENTENCE).toContain("£500");
    expect(dateChangeConfirmationSubject(changeMeta)).toContain("MMR001");
  });
});

/* ----------------------------------------------------- the hard copy rule */

describe('the word "penalty" appears NOWHERE in customer or office copy', () => {
  const surfaces: string[] = [
    // Every builder output, in both confirmed and unconfirmed shapes.
    buildCancellationAckEmailHtml(ackMeta),
    buildCancellationAckEmailHtml({ ...ackMeta, dateConfirmed: false }),
    cancellationAckText(ackMeta),
    cancellationAckSubject(ackMeta),
    JSON.stringify(cancellationAckTemplateVars(ackMeta)),
    buildMarleyCancelEmailHtml(marleyMeta),
    buildMarleyCancelEmailHtml({ ...marleyMeta, refundTotal: 0 }),
    marleyCancelText(marleyMeta),
    marleyCancelSubject(marleyMeta),
    JSON.stringify(marleyCancelTemplateVars(marleyMeta)),
    buildDateChangeConfirmationEmailHtml(changeMeta),
    dateChangeConfirmationText(changeMeta),
    dateChangeConfirmationSubject(changeMeta),
    JSON.stringify(dateChangeConfirmationTemplateVars(changeMeta)),
    // The shared office dialog copy.
    INSIDE_WINDOW_CHANGE_WARNING,
    CANCEL_CONFIRMED_WARNING,
    CANCEL_UNCONFIRMED_NOTE,
    MARLEY_CANCEL_NOTE,
  ];

  it.each(surfaces.map((s, i) => [i, s] as const))("surface %i is penalty-free", (_i, s) => {
    expect(s.toLowerCase()).not.toContain("penalty");
  });
});
