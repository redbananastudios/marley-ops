import { describe, expect, it } from "vitest";
import { buildBalanceInvoiceEmailHtml, BANK_DETAILS } from "@/lib/comms/payment-email";

/**
 * Gate 9b: a late booking meets its final-balance email BEFORE it has paid a
 * penny, because the balance is now raised at acceptance rather than by the
 * T-7 cron (PRD §3.10 Addition 2).
 *
 * The pre-existing copy says the deposit "is already accounted for". That is
 * true of the arithmetic — the balance is agreed − deposit whether or not the
 * deposit has been paid — and it reads to someone who has paid nothing as "you
 * have already paid it". These lock the two renderings apart.
 */

const NO_EM_DASH = (html: string) => expect(html).not.toMatch(/—/);

const base = {
  firstName: "Jane Smith",
  quoteRef: "MMR042",
  amount: 1500,
  moveDateLabel: "Thursday 20 August",
  invoiceUrl: "https://inv.example/x",
  invoiceNumber: "INV-000200",
};

describe("balance invoice email — deposit still outstanding", () => {
  it("is byte-identical to today when the deposit is settled", () => {
    // The ordinary T-7 raise. Absent, null and 0 must all render the original
    // email: this is the parity assertion for every balance ever sent so far.
    const original = buildBalanceInvoiceEmailHtml(base);
    expect(buildBalanceInvoiceEmailHtml({ ...base, depositOutstanding: null })).toBe(original);
    expect(buildBalanceInvoiceEmailHtml({ ...base, depositOutstanding: 0 })).toBe(original);
    expect(original).toContain("deposit is already accounted for");
  });

  it("drops the 'already accounted for' line when the deposit is unpaid", () => {
    const html = buildBalanceInvoiceEmailHtml({ ...base, depositOutstanding: 500 });
    expect(html).not.toContain("already accounted for");
    expect(html).toContain("still to pay");
  });

  it("names the deposit, the balance and what they come to together", () => {
    const html = buildBalanceInvoiceEmailHtml({ ...base, depositOutstanding: 500 });
    expect(html).toContain("£500"); // the deposit still owed
    expect(html).toContain("£1,500"); // this invoice
    expect(html).toContain("£2,000"); // the whole bill before move day
  });

  it("says the two invoices can be paid separately or together, on one reference", () => {
    // The bank feed's whole-quote link (#73) settles a single covering transfer,
    // so telling the customer they may do that is a promise the panel can keep.
    const html = buildBalanceInvoiceEmailHtml({ ...base, depositOutstanding: 500 });
    expect(html).toContain("separately or in one transfer");
    expect(html).toContain(">MMR042<");
    expect(html).toContain(BANK_DETAILS.account);
  });

  it("explains WHY it has arrived early rather than just arriving early", () => {
    const html = buildBalanceInvoiceEmailHtml({ ...base, depositOutstanding: 500 });
    expect(html).toContain("is close");
    expect(html).toContain("Thursday 20 August");
  });

  it("keeps the balance rail card-free, exactly as the settled version is", () => {
    // Peter, 2026-07-09: card fees are too high at balance values, and the
    // invoice itself is raised with online payments disabled — a card button
    // here would be a dead end.
    const html = buildBalanceInvoiceEmailHtml({ ...base, depositOutstanding: 500 });
    expect(html.toLowerCase()).not.toContain("pay by card");
    expect(html).toContain("View your invoice");
  });

  it("holds the house copy rules", () => {
    NO_EM_DASH(buildBalanceInvoiceEmailHtml({ ...base, depositOutstanding: 500 }));
  });

  it("ignores a nonsensical negative outstanding deposit", () => {
    expect(buildBalanceInvoiceEmailHtml({ ...base, depositOutstanding: -50 })).toBe(
      buildBalanceInvoiceEmailHtml(base),
    );
  });
});
