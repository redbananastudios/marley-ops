import { afterEach, describe, expect, it } from "vitest";

import { adapterFor, configuredProvider, LedgerError } from "@/lib/ledger";
import { zohoAdapter } from "@/lib/ledger/zoho-adapter";
import { xeroAdapter } from "@/lib/ledger/xero-adapter";

const original = process.env.LEDGER_PROVIDER;
afterEach(() => {
  if (original === undefined) delete process.env.LEDGER_PROVIDER;
  else process.env.LEDGER_PROVIDER = original;
});

describe("configuredProvider", () => {
  it("defaults to zoho when unset — an untouched environment changes by nothing", () => {
    delete process.env.LEDGER_PROVIDER;
    expect(configuredProvider()).toBe("zoho");
  });

  it("accepts either provider, case- and whitespace-insensitively", () => {
    process.env.LEDGER_PROVIDER = "zoho";
    expect(configuredProvider()).toBe("zoho");
    process.env.LEDGER_PROVIDER = "  XERO ";
    expect(configuredProvider()).toBe("xero");
  });

  /**
   * The whole point of the guard. A typo that silently resolved to Zoho would
   * keep raising real customer invoices in the system everyone had just stopped
   * reading, and no screen anywhere would say so.
   */
  it("THROWS on an unrecognised value rather than falling back to zoho", () => {
    process.env.LEDGER_PROVIDER = "xerro";
    expect(() => configuredProvider()).toThrow(LedgerError);
    expect(() => configuredProvider()).toThrow(/Refusing to guess/);
  });

  it("treats an empty string as unrecognised, not as unset", () => {
    process.env.LEDGER_PROVIDER = "";
    expect(() => configuredProvider()).toThrow(/expected "zoho" or "xero"/);
  });
});

describe("adapterFor", () => {
  it("resolves the configured provider when no per-document override is given", () => {
    delete process.env.LEDGER_PROVIDER;
    expect(adapterFor()).toBe(zohoAdapter);
    expect(adapterFor().provider).toBe("zoho");
  });

  /**
   * design §8: an invoice id stored months ago belongs to whichever system
   * minted it, so the override must beat the global switch — not merely be
   * accepted and ignored.
   */
  it("lets a per-document provider override the configured one", () => {
    process.env.LEDGER_PROVIDER = "xero";
    expect(adapterFor("zoho")).toBe(zohoAdapter);
  });

  it("treats a null override as absent (an un-stamped row falls back to config)", () => {
    delete process.env.LEDGER_PROVIDER;
    expect(adapterFor(null)).toBe(zohoAdapter);
  });

  /**
   * Shipped at gate 18b. The routing matters as much as the adapter: a stored
   * invoice id belongs to whichever system minted it, so a per-document stamp
   * must reach the right adapter even after the global provider flips. Getting
   * this wrong is not a loud failure — a not-found reads as transient, a
   * customer who HAS paid is never marked paid, and the cron keeps reporting a
   * healthy run.
   */
  it("routes to the Xero adapter, both by config and by per-document stamp", () => {
    process.env.LEDGER_PROVIDER = "xero";
    expect(adapterFor()).toBe(xeroAdapter);
    expect(adapterFor().provider).toBe("xero");

    process.env.LEDGER_PROVIDER = "zoho";
    expect(adapterFor("xero")).toBe(xeroAdapter);
    // ...and the two never collapse into one another.
    expect(adapterFor("xero")).not.toBe(adapterFor("zoho"));
  });
});
