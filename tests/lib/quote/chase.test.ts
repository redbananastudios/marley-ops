import { describe, expect, it } from "vitest";
import {
  depositLabel,
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
      // owner-aware sign-off; no owner on ctx → the team, never a hardcoded person
      expect(e.text).toContain("The Marley Moves Team");
      expect(e.text).not.toContain("Peter");
      expect(e.text).not.toContain("Connor");
    }
  });

  it("capitalises customer + owner names that arrive all-lower or all-upper", () => {
    const e1 = quoteChaseEmail(1, { ...ctx, firstName: "freddy", ownerName: "luke" });
    expect(e1.subject).toContain("Freddy");
    expect(e1.text).toContain("Hi Freddy,");
    expect(e1.text).toContain("It's Luke here.");
    expect(e1.variables.CUSTOMER_FIRST_NAME).toBe("Freddy");
    expect(e1.variables.OWNER_NAME).toBe("Luke");
    // all-upper collapses too
    expect(quoteChaseEmail(1, { ...ctx, firstName: "FREDDY" }).variables.CUSTOMER_FIRST_NAME).toBe("Freddy");
    // intentional mixed case is left untouched
    expect(quoteChaseEmail(1, { ...ctx, firstName: "McDonald" }).variables.CUSTOMER_FIRST_NAME).toBe("McDonald");
  });

  it("sends each chase from the owner's OWN company mailbox; hello@ otherwise (never a personal off-domain box)", () => {
    // Owner with a company-domain login → their own address is the From.
    const personal = quoteChaseEmail(1, {
      ...ctx,
      ownerName: "luke james",
      ownerEmail: "luke@marleymoves.co.uk",
    });
    expect(personal.from).toBe("Luke at Marley Moves <luke@marleymoves.co.uk>");
    // Owner known but no usable company address → display name at hello@.
    const owned = quoteChaseEmail(1, { ...ctx, ownerName: "luke james" });
    expect(owned.from).toBe("Luke at Marley Moves <hello@marleymoves.co.uk>");
    // An off-domain login must NEVER become the sender (gmail, .test, etc).
    const offDomain = depositChaseEmail(1, {
      ...ctx,
      ownerName: "Connor",
      ownerEmail: "connor@marleymoves.test",
    });
    expect(offDomain.from).toBe("Connor at Marley Moves <hello@marleymoves.co.uk>");
    // no owner known → generic Marley sender, still the monitored mailbox
    expect(quoteChaseEmail(1, ctx).from).toBe("Marley Moves <hello@marleymoves.co.uk>");
    for (const e of [quoteChaseEmail(1, ctx), depositChaseEmail(1, { ...ctx, ownerName: "LUKE" })]) {
      expect(e.from).toContain("hello@marleymoves.co.uk");
      expect(e.from).not.toContain("peter@marleymoves.co.uk");
    }
  });

  it("final quote chase names the expiry and the ref; deposit chases name the ref", () => {
    // The expiry moved out of the subject and into the body when the final
    // chase was warmed up (2026-08-11) — a deadline headline was the wrong
    // opening for the one email that exists to re-open a conversation.
    expect(quoteChaseEmail(3, ctx).text).toContain("8 August");
    expect(quoteChaseEmail(3, ctx).text).toContain("MM-T-9");
    expect(depositChaseEmail(1, ctx).subject).toContain("MM-T-9");
    expect(depositChaseEmail(1, ctx).text).toContain("Bank transfer reference: MM-T-9");
  });

  it("the FINAL quote chase asks for no money at all", () => {
    // Peter, 2026-08-11: after three unanswered emails, quoting a deposit
    // figure at someone we have never spoken to reads as pressure. This is the
    // one email in the ladder that must stay money-free, whatever the deposit
    // is set to, so assert on the absence of any figure rather than one string.
    for (const amount of [undefined, "£100", "£420", "£300"]) {
      const email = quoteChaseEmail(3, { ...ctx, depositAmount: amount });
      expect(email.text).not.toMatch(/£/);
      expect(email.subject).not.toMatch(/£/);
      expect(email.text.toLowerCase()).not.toContain("deposit");
    }
    // ...while the earlier steps still name it, so the ask never goes missing.
    expect(quoteChaseEmail(2, { ...ctx, depositAmount: "£420" }).text).toContain("£420 deposit");
  });

  it("fallback HTML escapes and links, then adds the TEAM signature (never a hardcoded individual)", () => {
    const html = chaseTextToHtml("Hi <Jane>,\nhttps://ops.marleymoves.co.uk/q/x");
    expect(html).toContain("&lt;Jane&gt;");
    expect(html).toContain('<a href="https://ops.marleymoves.co.uk/q/x"');
    expect(html).toContain("The Marley Moves Team");
    expect(html).toContain("mailto:hello@marleymoves.co.uk");
    // The owner voice lives in the message TEXT; the signature block stays
    // person-free so a stale name can never front someone else's lead.
    expect(html).not.toContain("Peter Farrell");
    expect(html).not.toContain("peter@marleymoves.co.uk");
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
    // now carries a display name so mail clients hide the raw token
    expect(addr).toBe(`Marley Moves <q-${token}@reply.marleymoves.co.uk>`);
    expect(tokenFromReplyAddress(addr)).toBe(token);
    // the bare recipient form Resend inbound may deliver still parses
    expect(tokenFromReplyAddress(`q-${token}@reply.marleymoves.co.uk`)).toBe(token);
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

describe("deposit amount in chase copy (found by /qa 2026-08-05)", () => {
  const ctx = {
    firstName: "Jane Smith",
    quoteRef: "MM-T-9",
    acceptUrl: "https://ops.marleymoves.co.uk/q/tok123",
    expiryLabel: "8 August",
  };

  it("interpolates the real ask — a £300 late-booking deposit never reads as £100", () => {
    const bumped = { ...ctx, depositAmount: "£300" };
    expect(depositChaseEmail(1, bumped).text).toContain("£300 deposit");
    expect(depositChaseEmail(1, bumped).text).not.toContain("£100");
    expect(depositChaseEmail(2, bumped).text).toContain("£300 deposit");
    expect(quoteChaseEmail(2, bumped).text).toContain("£300 deposit");
    expect(depositChaseEmail(1, bumped).variables.DEPOSIT_AMOUNT).toBe("£300");
  });

  it("defaults to £100 when no amount is passed (pre-existing rows, settings default)", () => {
    expect(depositChaseEmail(1, ctx).text).toContain("£100 deposit");
    expect(depositChaseEmail(1, ctx).variables.DEPOSIT_AMOUNT).toBe("£100");
  });

  it("depositLabel formats whole pounds and pence honestly", () => {
    expect(depositLabel(100)).toBe("£100");
    expect(depositLabel(300)).toBe("£300");
    expect(depositLabel(187.5)).toBe("£187.50");
    expect(depositLabel(null)).toBe("£100");
    expect(depositLabel(0)).toBe("£100");
  });
});
