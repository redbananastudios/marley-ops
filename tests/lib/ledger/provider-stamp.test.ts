import { afterEach, describe, expect, it } from "vitest";

import { asProvider, configuredProvider, LedgerError, reusableContactId } from "@/lib/ledger";

/**
 * Migration 0109 stamps WHICH ledger minted each stored document id, and this
 * file pins the two decisions that make the stamp worth having.
 *
 * The failure it guards against is not loud. `LEDGER_PROVIDER` is one global
 * switch, so the moment it flips every id stored under the old system is read
 * against the new one. A not-found reads as a transient outage, the customer
 * who HAS paid is never marked paid, the poller reports a healthy run, and the
 * chase emails keep going out. Nothing on any screen says the wrong system was
 * asked.
 */

const ORIGINAL = process.env.LEDGER_PROVIDER;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.LEDGER_PROVIDER;
  else process.env.LEDGER_PROVIDER = ORIGINAL;
});

describe("asProvider — reading a stamp back out of the database", () => {
  it("passes the two known providers through", () => {
    expect(asProvider("zoho")).toBe("zoho");
    expect(asProvider("xero")).toBe("xero");
  });

  /**
   * The whole point. A stamp this build does not understand must NOT quietly
   * become "whatever the environment says today" — that is precisely the
   * wrong-system read the column exists to prevent, and it would be silent.
   */
  it("throws on an unrecognised stamp rather than falling back", () => {
    expect(() => asProvider("quickbooks")).toThrow(LedgerError);
    expect(() => asProvider("Zoho")).toThrow(/not recognised/);
    expect(() => asProvider("")).toThrow(/not recognised/);
  });

  it("says what it refused and why, so the error is actionable at 3am", () => {
    expect(() => asProvider("sage")).toThrow(/"sage"/);
    expect(() => asProvider("sage")).toThrow(/Refusing to guess/);
  });

  /**
   * Null is "no id stored here", not "unknown system" — the callers pass it
   * only for an empty slot. Safe ONLY because the database enforces the pairing
   * (migration 0110's CHECKs), which is why that constraint is not optional.
   */
  it("treats null and undefined as 'no override'", () => {
    expect(asProvider(null)).toBeNull();
    expect(asProvider(undefined)).toBeNull();
  });
});

describe("configuredProvider — where NEW documents are raised", () => {
  it("defaults to zoho, so an untouched environment changes by nothing", () => {
    delete process.env.LEDGER_PROVIDER;
    expect(configuredProvider()).toBe("zoho");
  });

  it("accepts either provider, case- and whitespace-insensitively", () => {
    process.env.LEDGER_PROVIDER = " XERO ";
    expect(configuredProvider()).toBe("xero");
  });

  /**
   * A typo must not resolve to Zoho. It would keep raising real customer
   * invoices in the system everyone had just stopped reading, and no screen
   * anywhere would say so.
   */
  it("throws on a typo rather than falling back to zoho", () => {
    process.env.LEDGER_PROVIDER = "xerro";
    expect(() => configuredProvider()).toThrow(/expected "zoho" or "xero"/);
  });
});

/**
 * The property the six columns exist for, stated directly: reading a stored
 * document must not depend on today's configuration.
 */
describe("a stored stamp outranks the configured provider", () => {
  it("routes an old Zoho id to Zoho even after the flip", () => {
    process.env.LEDGER_PROVIDER = "xero";
    expect(configuredProvider()).toBe("xero");
    // What every read call site passes: the slot's own stamp, not the default.
    expect(asProvider("zoho")).toBe("zoho");
    expect(asProvider("zoho")).not.toBe(configuredProvider());
  });
});

/**
 * The contact rule, tested directly because it is the sharpest edge in the
 * flip and the one with a recurring cost rather than a one-off failure.
 */
describe("reusableContactId", () => {
  it("reuses a contact minted by the ledger being raised in", () => {
    expect(reusableContactId("460000001", "zoho", "zoho")).toBe("460000001");
  });

  /**
   * The bug this exists for: `isRealZohoId` would have said yes here, Xero
   * would have been handed a Zoho contact id, and createInvoice would fail with
   * an error indistinguishable from an outage.
   */
  it("refuses a contact minted by the OTHER ledger", () => {
    expect(reusableContactId("460000001", "zoho", "xero")).toBeNull();
    expect(reusableContactId("a-guid", "xero", "zoho")).toBeNull();
  });

  it("refuses the in-flight creation claim and the empty cases", () => {
    expect(reusableContactId("pending", "zoho", "zoho")).toBeNull();
    expect(reusableContactId(null, "zoho", "zoho")).toBeNull();
    expect(reusableContactId("", "zoho", "zoho")).toBeNull();
  });

  /**
   * An unstamped id cannot happen once 0110's CHECK is on, but if it ever did
   * the safe answer is a fresh contact: the cost is a duplicate contact record,
   * against a failed invoice raise for guessing wrong.
   */
  it("refuses an unstamped id rather than assuming it is ours", () => {
    expect(reusableContactId("460000001", null, "zoho")).toBeNull();
  });

  it("still throws on a corrupt stamp rather than silently creating a duplicate", () => {
    expect(() => reusableContactId("460000001", "sage", "zoho")).toThrow(LedgerError);
  });
});
