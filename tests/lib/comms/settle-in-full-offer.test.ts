import { describe, expect, it } from "vitest";
import {
  buildDateConfirmationEmailHtml,
  dateConfirmationTemplateVars,
  type DateConfirmationMeta,
} from "@/lib/comms/date-confirm-email";

/**
 * Gate 9c (PRD §3.10 Addition 3) — the commitment email offers both figures.
 *
 * The safety property of this whole feature is that ignoring the option changes
 * nothing, so the parity test below is the important one: with no balance to
 * offer, the email is byte-identical to the one every customer has had so far.
 *
 * The hosted Resend twin renders the whole thing through a single
 * {{{COMMITMENT_BLOCK}}} variable, so the offer reaches the templated send with
 * no Resend push at all — asserted here rather than assumed, because §11.7 trap
 * 4 is about exactly the divergence that assumption creates.
 */

const NO_EM_DASH = (s: string) => expect(s).not.toMatch(/—/);

const base: DateConfirmationMeta = {
  firstName: "Jane Smith",
  quoteRef: "MMR042",
  moveDateLabel: "Monday 20 July",
  depositAmount: 100,
  commitmentAmount: 500,
  commitmentDueLabel: "Monday 13 July",
  invoiceNumber: "INV-000200",
  invoiceUrl: "https://inv.example/x",
};

const offered: DateConfirmationMeta = {
  ...base,
  balanceRemaining: 1400,
  payUrl: "https://ops.example/q/tok",
};

describe("date-confirmation email — settle in full", () => {
  it("is byte-identical to today when there is nothing to offer", () => {
    // Absent, null and 0 must all reproduce the original. A customer whose
    // deposit already covers the commitment, a late booking and a small job all
    // arrive here with nothing remaining.
    const original = buildDateConfirmationEmailHtml(base);
    expect(buildDateConfirmationEmailHtml({ ...base, balanceRemaining: null })).toBe(original);
    expect(buildDateConfirmationEmailHtml({ ...base, balanceRemaining: 0 })).toBe(original);
    expect(original).not.toContain("settle in full");
    expect(original).not.toContain("Or settle in full");
  });

  it("ignores a nonsensical negative remainder", () => {
    expect(buildDateConfirmationEmailHtml({ ...base, balanceRemaining: -50 })).toBe(
      buildDateConfirmationEmailHtml(base),
    );
  });

  it("leads with the 25% the customer agreed, and offers the total second", () => {
    const html = buildDateConfirmationEmailHtml(offered);
    // Both figures, and the commitment comes first: this is an offer, not a nudge.
    expect(html).toContain("£500");
    expect(html).toContain("£1,900"); // 500 + 1400
    expect(html.indexOf("Commitment payment")).toBeLessThan(html.indexOf("Or settle in full"));
    expect(html).toContain("Nothing more to pay before your move");
  });

  it("sends them to their own booking page to take the choice", () => {
    const html = buildDateConfirmationEmailHtml(offered);
    expect(html).toContain("https://ops.example/q/tok");
    expect(html).toContain("settle in full");
    // …and degrades to plain words when there is no token to link.
    const noLink = buildDateConfirmationEmailHtml({ ...offered, payUrl: null });
    expect(noLink).toContain("settle in full");
    expect(noLink).not.toContain("<a href=\"null\"");
  });

  it("promises the reference does not change, because it does not", () => {
    // One reference, two invoices. A single covering transfer is settled by the
    // office's whole-quote link (#73) — so this is a promise the panel keeps.
    expect(buildDateConfirmationEmailHtml(offered)).toContain("bank reference stays the same");
  });

  it("still never says the word this ladder must never say", () => {
    const html = buildDateConfirmationEmailHtml(offered);
    expect(html.toLowerCase()).not.toContain("penalty");
    NO_EM_DASH(html);
  });

  it("reaches the hosted template through COMMITMENT_BLOCK, needing no Resend push", () => {
    // The hosted date-confirmation template renders {{{COMMITMENT_BLOCK}}}
    // verbatim, so an offer added inside that block appears on the templated
    // send too. If this ever stops being true, the templated customers silently
    // stop being offered the choice while the fallback ones keep getting it.
    const vars = dateConfirmationTemplateVars(offered);
    expect(vars.COMMITMENT_BLOCK).toContain("Or settle in full");
    expect(vars.COMMITMENT_BLOCK).toContain("£1,900");
    expect(dateConfirmationTemplateVars(base).COMMITMENT_BLOCK).not.toContain("Or settle in full");
  });
});
