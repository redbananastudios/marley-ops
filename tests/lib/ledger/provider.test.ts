import { afterEach, describe, expect, it } from "vitest";

import { adapterFor, configuredProvider, LedgerError } from "@/lib/ledger";
import { zohoAdapter } from "@/lib/ledger/zoho-adapter";

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

  it("says plainly that the Xero adapter has not shipped yet", () => {
    expect(() => adapterFor("xero")).toThrow(/has not shipped yet \(gate 18\)/);
  });
});
