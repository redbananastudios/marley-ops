import { afterEach, describe, expect, it } from "vitest";
import {
  accountsAddress,
  accountsFrom,
  capName,
  HELLO_FROM,
  opsAlertRecipient,
  ownerFrom,
  shouldForwardUnmatched,
} from "@/lib/comms/sender";

afterEach(() => {
  delete process.env.ACCOUNTS_EMAIL;
  delete process.env.OPS_ALERT_EMAIL;
  delete process.env.OPS_ALERT_EMAIL_MONEY;
  delete process.env.OPS_ALERT_EMAIL_SYSTEM;
});

describe("ownerFrom — the personal sales identity", () => {
  it("company-domain login → their own mailbox is the From", () => {
    expect(ownerFrom("Luke James", "luke@marleymoves.co.uk")).toBe(
      "Luke at Marley Moves <luke@marleymoves.co.uk>",
    );
    expect(ownerFrom("connor", "Connor@MarleyMoves.co.uk")).toBe(
      "Connor at Marley Moves <connor@marleymoves.co.uk>",
    );
  });

  it("off-domain login NEVER becomes the sender — display name at hello@", () => {
    expect(ownerFrom("Connor", "connor@marleymoves.test")).toBe(
      "Connor at Marley Moves <hello@marleymoves.co.uk>",
    );
    expect(ownerFrom("Luke", "luke@gmail.com")).toBe("Luke at Marley Moves <hello@marleymoves.co.uk>");
    // a lookalike domain must not pass the suffix check
    expect(ownerFrom("Luke", "luke@evilmarleymoves.co.uk")).toBe(
      "Luke at Marley Moves <hello@marleymoves.co.uk>",
    );
  });

  it("no name → derive the display from the company address; neither → house identity", () => {
    expect(ownerFrom(null, "luke@marleymoves.co.uk")).toBe("Luke at Marley Moves <luke@marleymoves.co.uk>");
    expect(ownerFrom(null, null)).toBe(HELLO_FROM);
    expect(ownerFrom("   ", "someone@gmail.com")).toBe(HELLO_FROM);
  });

  it("first name only, case-normalised", () => {
    expect(ownerFrom("luke christopher james", "luke@marleymoves.co.uk")).toBe(
      "Luke at Marley Moves <luke@marleymoves.co.uk>",
    );
    expect(ownerFrom("LUKE", null)).toBe("Luke at Marley Moves <hello@marleymoves.co.uk>");
  });
});

describe("capName", () => {
  it("normalises all-lower/all-upper; leaves deliberate mixed case", () => {
    expect(capName("freddy")).toBe("Freddy");
    expect(capName("FREDDY")).toBe("Freddy");
    expect(capName("McDonald")).toBe("McDonald");
  });
});

describe("accounts identity", () => {
  it("defaults to the money desk and honours the env override", () => {
    expect(accountsAddress()).toBe("accounts@marleymoves.co.uk");
    expect(accountsFrom()).toBe("Marley Moves Accounts <accounts@marleymoves.co.uk>");
    process.env.ACCOUNTS_EMAIL = "money@marleymoves.co.uk";
    expect(accountsFrom()).toBe("Marley Moves Accounts <money@marleymoves.co.uk>");
  });
});

describe("opsAlertRecipient — category routing", () => {
  it("money → accounts desk, system → the engineer, default → front door", () => {
    expect(opsAlertRecipient("money")).toBe("accounts@marleymoves.co.uk");
    expect(opsAlertRecipient("system")).toBe("peter@marleymoves.co.uk");
    expect(opsAlertRecipient("business")).toBe("hello@marleymoves.co.uk");
    expect(opsAlertRecipient()).toBe("hello@marleymoves.co.uk");
  });

  it("env overrides win per category", () => {
    process.env.OPS_ALERT_EMAIL = "office@x.test";
    process.env.OPS_ALERT_EMAIL_MONEY = "books@x.test";
    process.env.OPS_ALERT_EMAIL_SYSTEM = "eng@x.test";
    expect(opsAlertRecipient()).toBe("office@x.test");
    expect(opsAlertRecipient("money")).toBe("books@x.test");
    expect(opsAlertRecipient("system")).toBe("eng@x.test");
  });
});

describe("shouldForwardUnmatched — the catch-all loop guard", () => {
  it("forwards real external senders", () => {
    expect(shouldForwardUnmatched("Jane Smith <jane.smith@gmail.com>")).toBe(true);
    expect(shouldForwardUnmatched("bob@company.co.uk")).toBe(true);
  });

  it("never forwards our own mail or machine chatter (bounce-loop guard)", () => {
    expect(shouldForwardUnmatched("hello@marleymoves.co.uk")).toBe(false);
    expect(shouldForwardUnmatched("Marley Moves <q-abc123@reply.marleymoves.co.uk>")).toBe(false);
    expect(shouldForwardUnmatched("MAILER-DAEMON@mx.example.com")).toBe(false);
    expect(shouldForwardUnmatched("postmaster@somewhere.com")).toBe(false);
    expect(shouldForwardUnmatched("no-reply@notifications.example.com")).toBe(false);
    expect(shouldForwardUnmatched("bounces@amazonses.com")).toBe(false);
    expect(shouldForwardUnmatched(null)).toBe(false);
    expect(shouldForwardUnmatched("not-an-email")).toBe(false);
  });
});
