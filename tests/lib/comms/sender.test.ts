import { afterEach, describe, expect, it } from "vitest";
import {
  accountsAddress,
  accountsFrom,
  accountsFromFor,
  brandInboundDomains,
  capName,
  HELLO_FROM,
  helloFromFor,
  opsAlertRecipient,
  ownerFrom,
  shouldForwardUnmatched,
} from "@/lib/comms/sender";
import { mapBrand } from "@/lib/brand";

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

  it("header-injection hardening: names lose address syntax; malformed addresses are rejected", () => {
    // A display name can never smuggle a second address into the From header.
    expect(ownerFrom('Luke <evil@attacker.com>', "luke@marleymoves.co.uk")).toBe(
      "Luke at Marley Moves <luke@marleymoves.co.uk>",
    );
    expect(ownerFrom('"Luke", CEO\r\nBcc: x', "luke@marleymoves.co.uk")).toBe(
      "Luke at Marley Moves <luke@marleymoves.co.uk>",
    );
    // An email value that isn't a plain local@domain token never becomes the sender.
    expect(ownerFrom("Luke", "luke@marleymoves.co.uk>bcc:x@y.com")).toBe(
      "Luke at Marley Moves <hello@marleymoves.co.uk>",
    );
    expect(ownerFrom("Luke", "luke smith@marleymoves.co.uk")).toBe(
      "Luke at Marley Moves <hello@marleymoves.co.uk>",
    );
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
    expect(accountsFrom()).toBe("Marley Moves <accounts@marleymoves.co.uk>");
    process.env.ACCOUNTS_EMAIL = "money@marleymoves.co.uk";
    expect(accountsFrom()).toBe("Marley Moves <money@marleymoves.co.uk>");
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
    expect(shouldForwardUnmatched("do-not-reply@service.example.com")).toBe(false);
    expect(shouldForwardUnmatched("bounces@amazonses.com")).toBe(false);
    expect(shouldForwardUnmatched("bounce+luke=x@mailer.example.com")).toBe(false);
    expect(shouldForwardUnmatched(null)).toBe(false);
    expect(shouldForwardUnmatched("not-an-email")).toBe(false);
  });

  it("robot check anchors on the LOCAL PART — real people at bounce-ish addresses still forward", () => {
    expect(shouldForwardUnmatched("info@bounce-castles.co.uk")).toBe(true);
    expect(shouldForwardUnmatched("jenny.osbounce@gmail.com")).toBe(true);
    expect(shouldForwardUnmatched('"Bounce Castles Ltd" <sales@partyhire.example.com>')).toBe(true);
    // ...but a lookalike domain of ours never gets forwarded to
    expect(shouldForwardUnmatched("x@sub.reply.marleymoves.co.uk")).toBe(false);
  });

  it("extraDomains WIDEN the own-mail set — Marley recognition never narrows (trap 3)", () => {
    const extra = ["pitmansremovals.co.uk", "reply.pitmansremovals.co.uk"];
    expect(shouldForwardUnmatched("info@pitmansremovals.co.uk", extra)).toBe(false);
    expect(shouldForwardUnmatched("Pitmans <q-t0k@reply.pitmansremovals.co.uk>", extra)).toBe(false);
    // the base Marley set survives whatever is passed in
    expect(shouldForwardUnmatched("hello@marleymoves.co.uk", extra)).toBe(false);
    expect(shouldForwardUnmatched("q-abc@reply.marleymoves.co.uk", extra)).toBe(false);
    // real customers still forward with the widened set in force
    expect(shouldForwardUnmatched("jane.smith@gmail.com", extra)).toBe(true);
    // a lookalike of the extra domain does not pass the suffix check
    expect(shouldForwardUnmatched("x@notpitmansremovals.co.uk", extra)).toBe(true);
  });
});

const pitmans = mapBrand({
  slug: "pitmans",
  name: "Pitmans Removals & Storage",
  short_name: "Pitmans",
  email_domain: "pitmansremovals.co.uk",
  hello_from: "info@pitmansremovals.co.uk",
  accounts_from: "accounts@pitmansremovals.co.uk",
  reply_domain: "reply.pitmansremovals.co.uk",
});
const marley = mapBrand({
  slug: "marley",
  name: "Marley Moves",
  short_name: "Marley",
  email_domain: "marleymoves.co.uk",
  hello_from: "hello@marleymoves.co.uk",
  accounts_from: "accounts@marleymoves.co.uk",
});
const group = mapBrand({ slug: "group", name: "Marley Group", short_name: "Group" });

describe("brand From identities — Marley byte-identical, others from the row", () => {
  it("marley resolves to EXACTLY today's identities, env override included", () => {
    expect(helloFromFor(marley)).toBe(HELLO_FROM);
    expect(accountsFromFor(marley)).toBe(accountsFrom());
    process.env.ACCOUNTS_EMAIL = "money@marleymoves.co.uk";
    expect(accountsFromFor(marley)).toBe("Marley Moves <money@marleymoves.co.uk>");
  });

  it("a non-default brand formats name + row address", () => {
    expect(helloFromFor(pitmans)).toBe("Pitmans Removals & Storage <info@pitmansremovals.co.uk>");
    expect(accountsFromFor(pitmans)).toBe("Pitmans Removals & Storage <accounts@pitmansremovals.co.uk>");
  });

  it("null fields (the group pseudo-brand) degrade to the Marley house identity (§11.10)", () => {
    expect(helloFromFor(group)).toBe(HELLO_FROM);
    expect(accountsFromFor(group)).toBe(accountsFrom());
  });

  it("header hardening: a malformed row address or injected name never reaches the From", () => {
    const bad = mapBrand({ slug: "pitmans", name: "Pitmans", hello_from: "info@pitmans.co.uk>bcc:x@y" });
    expect(helloFromFor(bad)).toBe(HELLO_FROM);
    const sneaky = mapBrand({
      slug: "pitmans",
      name: "Pitmans <evil@attacker.com>",
      hello_from: "info@pitmansremovals.co.uk",
    });
    // the injected address loses its header syntax AND its @, so no second
    // address token can appear in the display phrase
    expect(helloFromFor(sneaky)).toBe("Pitmans evil attacker.com <info@pitmansremovals.co.uk>");
  });
});

describe("ownerFrom extraDomains — widened recognition, zero-arg unchanged", () => {
  it("a widened domain can front; the Marley domain always can", () => {
    expect(ownerFrom("Mark", "mark@pitmansremovals.co.uk", ["pitmansremovals.co.uk"])).toBe(
      "Mark at Marley Moves <mark@pitmansremovals.co.uk>",
    );
    expect(ownerFrom("Luke", "luke@marleymoves.co.uk", ["pitmansremovals.co.uk"])).toBe(
      "Luke at Marley Moves <luke@marleymoves.co.uk>",
    );
    // without the widening argument the off-domain address still never fronts
    expect(ownerFrom("Mark", "mark@pitmansremovals.co.uk")).toBe(
      "Mark at Marley Moves <hello@marleymoves.co.uk>",
    );
  });
});

describe("brandInboundDomains", () => {
  it("collects email + reply domains, dropping nulls and duplicates", () => {
    expect(brandInboundDomains([marley, pitmans, group])).toEqual([
      "marleymoves.co.uk",
      "pitmansremovals.co.uk",
      "reply.pitmansremovals.co.uk",
    ]);
    expect(brandInboundDomains([])).toEqual([]);
  });
});
