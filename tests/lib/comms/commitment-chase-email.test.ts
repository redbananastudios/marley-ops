import { describe, expect, it } from "vitest";
import {
  COMMITMENT_CHASE_TEMPLATE_ENV,
  COMMITMENT_CHASE_WARNING,
  commitmentDueLabel,
  composeCommitmentChaseEmail,
  buildCommitmentChaseEmailHtml,
  type CommitmentChaseMeta,
} from "@/lib/comms/commitment-chase-email";
import { DATE_CONFIRM_ACKS } from "@/lib/signatures";

/**
 * Commitment chase copy (Payments Policy v2 template B). The hard rules:
 * the inside-7-day warning is the DATE_CONFIRM_ACK promise VERBATIM, the word
 * "penalty" never appears anywhere, and every amount shown is gross.
 */

const meta: CommitmentChaseMeta = {
  firstName: "Jane Smith",
  quoteRef: "MMR001",
  amount: 500,
  dueDate: "2026-08-14",
  movingDate: "2026-08-21",
  invoiceUrl: "https://books.zoho.eu/inv/abc123",
  invoiceNumber: "INV-000201",
  todayUk: "2026-08-01",
};

describe("commitmentDueLabel", () => {
  it("names the due date while it is still ahead", () => {
    expect(commitmentDueLabel("2026-08-14", "2026-08-01")).toMatch(/^by \w+ 14 August$/);
  });

  it("late collapse: due date today or already past → 'today'", () => {
    expect(commitmentDueLabel("2026-08-01", "2026-08-01")).toBe("today");
    expect(commitmentDueLabel("2026-07-25", "2026-08-01")).toBe("today");
  });

  it("missing / garbage due date collapses to 'today' — the only honest answer", () => {
    expect(commitmentDueLabel(null, "2026-08-01")).toBe("today");
    expect(commitmentDueLabel("soon", "2026-08-01")).toBe("today");
  });
});

describe("composeCommitmentChaseEmail — copy invariants", () => {
  const email = composeCommitmentChaseEmail(meta);

  it("carries the gross amount, the ref, the move date, and the due label", () => {
    expect(email.subject).toContain("MMR001");
    expect(email.subject).toMatch(/due by \w+ 14 August/);
    expect(email.text).toContain("£500");
    expect(email.text).toContain("21 August");
    expect(email.html).toContain("£500");
    expect(email.variables.AMOUNT).toBe("£500");
    expect(email.variables.QUOTE_REF).toBe("MMR001");
  });

  it("quotes the DATE_CONFIRM_ACK promise VERBATIM (imported, single source)", () => {
    expect(COMMITMENT_CHASE_WARNING).toBe(DATE_CONFIRM_ACKS[0].label);
    expect(email.text).toContain(`"${DATE_CONFIRM_ACKS[0].label}"`);
    // The template variable is the same string, HTML-escaped only.
    expect(email.variables.DATE_CONFIRM_ACK).toContain("refunded in full if the day is re-booked");
    // Held-against-your-date framing survives into the fallback HTML.
    expect(email.html).toContain("may be retained");
    expect(email.html).toContain("refunded in full if the day is re-booked");
  });

  it("the word 'penalty' appears NOWHERE (subject, text, html, variables)", () => {
    const everything = [
      email.subject,
      email.text,
      email.html,
      JSON.stringify(email.variables),
    ].join("\n");
    expect(everything.toLowerCase()).not.toContain("penalty");
  });

  it("no em-dashes outside the verbatim acknowledgment quote", () => {
    expect(email.subject).not.toMatch(/—/);
    expect(email.text.split(COMMITMENT_CHASE_WARNING).join("")).not.toMatch(/—/);
  });

  it("carries the bank details with the quote ref as the transfer reference", () => {
    expect(email.text).toContain("MARLEYMOVES LTD");
    expect(email.text).toContain("04-00-03");
    expect(email.text).toContain("12787423");
    expect(email.text).toContain("Reference: MMR001");
    expect(email.html).toContain("How to pay");
    expect(email.html).toContain("card over the phone on 01747 637070");
  });

  it("links the hosted invoice when known, and omits the button otherwise", () => {
    expect(email.text).toContain("https://books.zoho.eu/inv/abc123");
    expect(email.variables.INVOICE_BUTTON).toContain("View your invoice");
    expect(email.variables.INVOICE_META).toContain("INV-000201");
    const bare = composeCommitmentChaseEmail({ ...meta, invoiceUrl: null, invoiceNumber: null });
    expect(bare.text).not.toContain("View your invoice");
    expect(bare.variables.INVOICE_BUTTON).toBe("");
    expect(bare.variables.INVOICE_META).toBe("");
    expect(bare.html).not.toContain("View your invoice");
  });

  it("late collapse reads 'due today' end to end", () => {
    const late = composeCommitmentChaseEmail({ ...meta, dueDate: "2026-08-01" });
    expect(late.subject).toContain("due today");
    expect(late.text).toContain("due today");
    expect(late.variables.DUE_LABEL).toBe("today");
  });

  it("uses the first name and falls back to 'there'", () => {
    expect(composeCommitmentChaseEmail(meta).text).toContain("Hi Jane,");
    const anon = composeCommitmentChaseEmail({ ...meta, firstName: null });
    expect(anon.text).toContain("Hi there,");
    // No ", there" bolted onto the HTML headline for anonymous leads.
    expect(anon.html).not.toContain(", there");
  });

  it("HTML-escapes customer-controlled strings in the fallback", () => {
    const html = buildCommitmentChaseEmailHtml({ ...meta, firstName: "<Jane>" });
    expect(html).toContain("&lt;Jane&gt;");
    expect(html).not.toContain("<Jane>");
  });

  it("names the template env the registry must publish under", () => {
    expect(COMMITMENT_CHASE_TEMPLATE_ENV).toBe("RESEND_TEMPLATE_COMMITMENT_CHASE");
  });
});
