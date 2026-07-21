import { describe, expect, it } from "vitest";
import {
  buildRefundExecutedEmailHtml,
  buildRetainedOutcomeEmailHtml,
  refundExecutedTemplateVars,
  retainedOutcomeTemplateVars,
  REFUND_SLA_LINE,
  type RefundExecutedMeta,
  type RetainedOutcomeMeta,
} from "@/lib/comms/refund-emails";

/**
 * Refund-queue customer emails (Payments Policy v2). The hard copy rules are
 * test-enforced here: the word "penalty" NEVER appears, no em/en dashes in
 * customer copy, amounts itemised gross, and the 14-day promise stated on
 * refund emails.
 */

const executedMeta = (over: Partial<RefundExecutedMeta> = {}): RefundExecutedMeta => ({
  firstName: "Freddy Arbuthnot",
  quoteRef: "MMR001",
  lines: [
    { label: "Deposit", railLabel: "back to your card ending 4242", amount: 100 },
    { label: "Commitment payment", railLabel: "by bank transfer", amount: 350 },
  ],
  totalRefund: 450,
  ...over,
});

const retainedMeta = (over: Partial<RetainedOutcomeMeta> = {}): RetainedOutcomeMeta => ({
  firstName: "Freddy Arbuthnot",
  quoteRef: "MMR001",
  originalDateLabel: "Friday 14 August 2026",
  retainedTotal: 350,
  refundLines: [{ label: "Commitment payment", railLabel: "by bank transfer", amount: 100 }],
  refundTotal: 100,
  ...over,
});

const allOutputs = (): string[] => [
  buildRefundExecutedEmailHtml(executedMeta()),
  buildRetainedOutcomeEmailHtml(retainedMeta()),
  buildRetainedOutcomeEmailHtml(retainedMeta({ refundLines: [], refundTotal: 0 })),
  JSON.stringify(refundExecutedTemplateVars(executedMeta())),
  JSON.stringify(retainedOutcomeTemplateVars(retainedMeta())),
  REFUND_SLA_LINE,
];

describe("hard copy rules", () => {
  it("the word 'penalty' appears NOWHERE, in any casing", () => {
    for (const out of allOutputs()) {
      expect(out.toLowerCase()).not.toContain("penalt");
    }
  });

  it("no em or en dashes in customer copy", () => {
    for (const out of allOutputs()) {
      expect(out).not.toMatch(/[–—]/);
    }
  });

  it("refund emails state the 14-day promise", () => {
    expect(buildRefundExecutedEmailHtml(executedMeta())).toContain("14 days");
    expect(buildRetainedOutcomeEmailHtml(retainedMeta())).toContain("14 days");
    expect(refundExecutedTemplateVars(executedMeta()).SLA_LINE).toContain("14 days");
  });
});

describe("refund-executed email", () => {
  it("itemises every rail line with its gross amount and the total", () => {
    const html = buildRefundExecutedEmailHtml(executedMeta());
    expect(html).toContain("Deposit");
    expect(html).toContain("back to your card ending 4242");
    expect(html).toContain("£100");
    expect(html).toContain("Commitment payment");
    expect(html).toContain("by bank transfer");
    expect(html).toContain("£350");
    expect(html).toContain("£450");
    expect(html).toContain("MMR001");
    expect(html).toContain("Freddy");
  });

  it("template vars carry the same lines for the dashboard template path", () => {
    const vars = refundExecutedTemplateVars(executedMeta());
    expect(vars.CUSTOMER_FIRST_NAME).toBe("Freddy");
    expect(vars.QUOTE_REF).toBe("MMR001");
    expect(vars.TOTAL_REFUND).toBe("£450");
    expect(vars.REFUND_LINES).toContain("£100");
    expect(vars.REFUND_LINES).toContain("£350");
  });

  it("escapes HTML in customer-supplied strings", () => {
    const html = buildRefundExecutedEmailHtml(
      executedMeta({ firstName: "<script>x</script>", lines: [{ label: "<b>Deposit</b>", railLabel: "by bank transfer", amount: 10 }], totalRefund: 10 }),
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>Deposit</b>");
  });
});

describe("retained-outcome email", () => {
  it("uses held-against-your-date framing with the retained amount", () => {
    const html = buildRetainedOutcomeEmailHtml(retainedMeta());
    expect(html).toContain("held against that date");
    expect(html).toContain("£350");
    expect(html).toContain("Friday 14 August 2026");
    expect(html).toContain("refunded in full");
  });

  it("itemises anything refunded above the held amount", () => {
    const html = buildRetainedOutcomeEmailHtml(retainedMeta());
    expect(html).toContain("Commitment payment");
    expect(html).toContain("£100");
  });

  it("omits the refund section entirely when nothing was refunded", () => {
    const html = buildRetainedOutcomeEmailHtml(retainedMeta({ refundLines: [], refundTotal: 0 }));
    expect(html).not.toContain("Refunded to you");
    const vars = retainedOutcomeTemplateVars(retainedMeta({ refundLines: [], refundTotal: 0 }));
    expect(vars.REFUND_SECTION).toBe("");
  });

  it("never mentions a credit note (deliberately none, by policy)", () => {
    expect(buildRetainedOutcomeEmailHtml(retainedMeta()).toLowerCase()).not.toContain("credit note");
  });

  it("copes with a missing date label", () => {
    const html = buildRetainedOutcomeEmailHtml(retainedMeta({ originalDateLabel: null }));
    expect(html).toContain("your original move date");
  });
});
