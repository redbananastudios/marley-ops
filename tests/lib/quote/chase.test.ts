import { describe, expect, it } from "vitest";
import {
  dueChaseStep,
  isQuoteLapsed,
  quoteChaseEmail,
  depositChaseEmail,
  chaseTextToHtml,
  replyAddressFor,
  tokenFromReplyAddress,
  expiryLabelFrom,
  LOSS_REASONS,
  QUOTE_CHASE_DAYS,
  DEPOSIT_CHASE_DAYS,
  CHASE_FROM,
} from "@/lib/quote/chase";

const DAY = 24 * 60 * 60 * 1000;
const iso = (offsetDays: number, from = new Date("2026-07-09T10:00:00Z")) =>
  new Date(from.getTime() + offsetDays * DAY).toISOString();
const NOW = new Date("2026-07-09T10:00:00Z");

describe("dueChaseStep — the cadence clock", () => {
  it("quote cadence fires on days 2 / 5 / 10, one step per run", () => {
    // sent 2 days ago, nothing sent yet → step 1 due
    expect(dueChaseStep(iso(-2), 0, QUOTE_CHASE_DAYS, NOW)).toBe(1);
    // sent 1.5 days ago → nothing due yet
    expect(dueChaseStep(iso(-1.5), 0, QUOTE_CHASE_DAYS, NOW)).toBeNull();
    // sent 6 days ago with step 1 already sent → step 2 due (not 3)
    expect(dueChaseStep(iso(-6), 1, QUOTE_CHASE_DAYS, NOW)).toBe(2);
    // sent 11 days ago, steps 1+2 sent → final step 3 due
    expect(dueChaseStep(iso(-11), 2, QUOTE_CHASE_DAYS, NOW)).toBe(3);
    // all 3 sent → sequence over
    expect(dueChaseStep(iso(-20), 3, QUOTE_CHASE_DAYS, NOW)).toBeNull();
  });

  it("catches up ONE step per run even when several are overdue", () => {
    // sent 12 days ago, nothing ever sent (engine was down) → sends step 1 only
    expect(dueChaseStep(iso(-12), 0, QUOTE_CHASE_DAYS, NOW)).toBe(1);
  });

  it("deposit cadence fires on days 1 / 3", () => {
    expect(dueChaseStep(iso(-1), 0, DEPOSIT_CHASE_DAYS, NOW)).toBe(1);
    expect(dueChaseStep(iso(-0.5), 0, DEPOSIT_CHASE_DAYS, NOW)).toBeNull();
    expect(dueChaseStep(iso(-3), 1, DEPOSIT_CHASE_DAYS, NOW)).toBe(2);
    expect(dueChaseStep(iso(-10), 2, DEPOSIT_CHASE_DAYS, NOW)).toBeNull();
  });

  it("null / garbage start → never due", () => {
    expect(dueChaseStep(null, 0, QUOTE_CHASE_DAYS, NOW)).toBeNull();
    expect(dueChaseStep("not-a-date", 0, QUOTE_CHASE_DAYS, NOW)).toBeNull();
  });
});

describe("30-day auto-lapse", () => {
  it("lapses at exactly 30 days, not before", () => {
    expect(isQuoteLapsed(iso(-29.9), NOW)).toBe(false);
    expect(isQuoteLapsed(iso(-30), NOW)).toBe(true);
    expect(isQuoteLapsed(null, NOW)).toBe(false);
  });
});

describe("chase copy (refreshed 2026-07-13)", () => {
  const ctx = {
    firstName: "Jane Smith",
    quoteRef: "MM-T-9",
    acceptUrl: "https://ops.marleymoves.co.uk/q/tok123",
    expiryLabel: "8 August",
  };

  it("every email carries the accept link, first name, and no em-dashes", () => {
    const all = [
      quoteChaseEmail(1, ctx),
      quoteChaseEmail(2, ctx),
      quoteChaseEmail(3, ctx),
      depositChaseEmail(1, ctx),
      depositChaseEmail(2, ctx),
    ];
    for (const e of all) {
      expect(e.text).toContain(ctx.acceptUrl);
      expect(e.text).toContain("Jane");
      expect(e.text).not.toMatch(/—/);
      expect(e.subject).not.toMatch(/—/);
      expect(e.variables.ACCEPT_LINK).toBe(ctx.acceptUrl);
      expect(e.text).toContain("Peter");
      expect(e.text).not.toContain("Connor");
    }
  });

  it("sends every chase as Peter from his Marley address", () => {
    expect(CHASE_FROM).toBe("Peter Farrell at Marley Moves <peter@marleymoves.co.uk>");
  });

  it("final quote chase names the expiry and the ref; deposit chases name the ref", () => {
    expect(quoteChaseEmail(3, ctx).subject).toContain("8 August");
    expect(quoteChaseEmail(3, ctx).text).toContain("MM-T-9");
    expect(depositChaseEmail(1, ctx).subject).toContain("MM-T-9");
    expect(depositChaseEmail(1, ctx).text).toContain("Bank transfer reference: MM-T-9");
  });

  it("fallback HTML escapes and links, then adds Peter's Outlook-style signature", () => {
    const html = chaseTextToHtml("Hi <Jane>,\nhttps://ops.marleymoves.co.uk/q/x");
    expect(html).toContain("&lt;Jane&gt;");
    expect(html).toContain('<a href="https://ops.marleymoves.co.uk/q/x"');
    expect(html).toContain("Peter Farrell");
    expect(html).toContain("mailto:peter@marleymoves.co.uk");
    expect(html).toContain("Ash Cottage, Sherborne Causeway");
    expect(html).not.toContain('width="600"');
    expect(html).toContain('width="100%"');
    expect(html).toContain("max-width:600px");
  });
});

describe("reply-address round trip (inbound webhook routing)", () => {
  it("token survives the address round trip with its case intact", () => {
    const token = "XaoNCO7FGwZzfN46T-HuZ5E9";
    const addr = replyAddressFor(token);
    expect(addr).toBe(`q-${token}@reply.marleymoves.co.uk`);
    expect(tokenFromReplyAddress(addr)).toBe(token);
    // display-name form Resend may deliver
    expect(tokenFromReplyAddress(`Marley Moves <${addr}>`)).toBe(token);
  });

  it("foreign addresses do not match", () => {
    expect(tokenFromReplyAddress("hello@marleymoves.co.uk")).toBeNull();
    expect(tokenFromReplyAddress("q-short@reply.marleymoves.co.uk")).toBeNull();
  });
});

describe("loss reasons", () => {
  it("carries the agreed reason set including the auto-lapse reason", () => {
    const values = LOSS_REASONS.map((r) => r.value);
    expect(values).toContain("too_expensive");
    expect(values).toContain("chose_competitor");
    expect(values).toContain("no_response");
    expect(values).toContain("other");
  });
});

describe("expiryLabelFrom", () => {
  it("30 days after the quote email, customer-formatted", () => {
    expect(expiryLabelFrom("2026-07-09T10:00:00Z", "2026-07-01T00:00:00Z")).toBe("8 August");
    // falls back to created when never emailed
    expect(expiryLabelFrom(null, "2026-07-01T00:00:00Z")).toBe("31 July");
  });
});
