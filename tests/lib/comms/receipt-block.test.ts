import { describe, it, expect } from "vitest";
import {
  ukReceiptDate,
  paymentMethodLabel,
  receiptDetailsBlock,
  receiptBlockVar,
  buildDepositReceivedEmailHtml,
  depositReceivedTemplateVars,
  buildBalanceReceivedEmailHtml,
  type ReceiptDetails,
} from "@/lib/comms/payment-email";
import {
  buildCommitmentReceivedEmailHtml,
  commitmentReceivedTemplateVars,
} from "@/lib/comms/date-confirm-email";

const receipt = (o: Partial<ReceiptDetails> = {}): ReceiptDetails => ({
  receiptNumber: "MMR019-DEP",
  paidAtLabel: "4 August 2026",
  method: "card",
  cardLast4: "4242",
  forLabel: "Booking deposit",
  amount: 100,
  ...o,
});

describe("ukReceiptDate", () => {
  it("formats an instant as a UK long date", () => {
    expect(ukReceiptDate(new Date("2026-08-04T09:00:00Z"))).toBe("4 August 2026");
    // Just after UK midnight is still that UK day.
    expect(ukReceiptDate(new Date("2026-08-03T23:30:00Z"))).toBe("4 August 2026");
  });
});

describe("paymentMethodLabel", () => {
  it("labels each method, showing the last 4 for a card", () => {
    expect(paymentMethodLabel("card", "4242")).toBe("Card ending 4242");
    expect(paymentMethodLabel("card", null)).toBe("Card");
    expect(paymentMethodLabel("card")).toBe("Card");
    expect(paymentMethodLabel("bank_transfer")).toBe("Bank transfer");
    expect(paymentMethodLabel("cash")).toBe("Cash");
  });
});

describe("receiptDetailsBlock", () => {
  it("renders receipt number, date, method, purpose and amount", () => {
    const html = receiptDetailsBlock(receipt());
    expect(html).toContain("Receipt");
    expect(html).toContain("MMR019-DEP");
    expect(html).toContain("4 August 2026");
    expect(html).toContain("Card ending 4242");
    expect(html).toContain("Booking deposit");
    expect(html).toContain("Amount received");
    expect(html).toContain("£100");
  });

  it("escapes interpolated values (no raw markup can leak in)", () => {
    const html = receiptDetailsBlock(receipt({ receiptNumber: "<script>x</script>" }));
    expect(html).not.toContain("<script>x");
    expect(html).toContain("&lt;script&gt;");
  });

  it("receiptBlockVar is empty when there is no receipt", () => {
    expect(receiptBlockVar(null)).toBe("");
    expect(receiptBlockVar(undefined)).toBe("");
    expect(receiptBlockVar(receipt())).toContain("MMR019-DEP");
  });
});

describe("deposit-received email with a receipt", () => {
  it("folds the receipt panel in while keeping the booking confirmation", () => {
    const html = buildDepositReceivedEmailHtml({
      firstName: "Jane Smith",
      quoteRef: "MMR019",
      amount: 100,
      moveDateLabel: "Monday 20 July",
      balanceAmount: 1150,
      receipt: receipt(),
    });
    expect(html).toContain("You're booked in, Jane"); // warmth preserved
    expect(html).toContain("MMR019-DEP"); // receipt folded in
    expect(html).toContain("Card ending 4242");
    expect(html).toContain("1,150"); // remaining balance line
    // The plain "Deposit paid" card is replaced by the richer receipt panel.
    expect(html).not.toContain(">Deposit paid<");
  });

  it("falls back to the plain amount card when no receipt is supplied (existing behaviour)", () => {
    const html = buildDepositReceivedEmailHtml({ firstName: "Jane", quoteRef: "MMR019", amount: 100 });
    expect(html).toContain("Deposit paid");
    expect(html).not.toContain("Receipt no.");
  });

  it("template vars carry the receipt block only when present", () => {
    expect(depositReceivedTemplateVars({ firstName: "Jane", quoteRef: "MMR019", amount: 100, receipt: receipt() }).RECEIPT_BLOCK)
      .toContain("MMR019-DEP");
    expect(depositReceivedTemplateVars({ firstName: "Jane", quoteRef: "MMR019", amount: 100 }).RECEIPT_BLOCK).toBe("");
  });
});

describe("balance + commitment received emails with a receipt", () => {
  it("balance email folds in a Final balance receipt", () => {
    const html = buildBalanceReceivedEmailHtml({
      firstName: "Jane",
      quoteRef: "MMR019",
      amount: 1700,
      moveDateLabel: "Monday 20 July",
      receipt: receipt({ receiptNumber: "MMR019-BAL", method: "bank_transfer", cardLast4: null, forLabel: "Final balance", amount: 1700 }),
    });
    expect(html).toContain("All settled, Jane");
    expect(html).toContain("MMR019-BAL");
    expect(html).toContain("Bank transfer");
    expect(html).toContain("Final balance");
  });

  it("commitment email folds in a Booking commitment receipt and never says penalty", () => {
    const meta = {
      firstName: "Jane",
      quoteRef: "MMR019",
      amount: 300,
      moveDateLabel: "Monday 20 July",
      receipt: receipt({ receiptNumber: "MMR019-COM", method: "cash", cardLast4: null, forLabel: "Booking commitment", amount: 300 }),
    };
    const html = buildCommitmentReceivedEmailHtml(meta);
    expect(html).toContain("Commitment received, Jane");
    expect(html).toContain("MMR019-COM");
    expect(html).toContain("Cash");
    expect(html).not.toMatch(/penalty/i);
    expect(commitmentReceivedTemplateVars(meta).RECEIPT_BLOCK).toContain("MMR019-COM");
  });
});
