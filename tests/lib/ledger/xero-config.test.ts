import { describe, expect, it } from "vitest";

import { LedgerError } from "@/lib/ledger";
import {
  xeroAccountEnvVar,
  xeroBrandingThemeId,
  xeroCardEnabled,
  xeroOrgShortCode,
  xeroPaymentAccountId,
  xeroTaxType,
} from "@/lib/ledger/xero-config";

/**
 * Every value this module returns names something inside ONE Xero organisation,
 * and the Demo Company mints new ids every 28 days. So the property under test
 * throughout is not "does it read the variable" — it is **what it does when the
 * variable is missing or wrong**, because that is the branch that decides
 * whether real customer money lands in the right nominal account.
 */

const BANK = "bd9e85e0-0478-433d-ae9f-0b3c4f04bfe4";
const CLEARING = "7b57750f-5fa4-46ac-a0ee-fccddaa8e9d0";
const THEME_STANDARD = "5d4dd402-c851-497e-aae1-9ff265c0d15a";
const THEME_NO_CARD = "43925494-c84e-43f0-8052-f969862f4a2f";

describe("xeroAccountEnvVar — the never-guess mode switch", () => {
  it("gives each rail its own variable", () => {
    expect(xeroAccountEnvVar("banktransfer")).toBe("XERO_ACCOUNT_BANKTRANSFER");
    expect(xeroAccountEnvVar("cash")).toBe("XERO_ACCOUNT_CASH");
    expect(xeroAccountEnvVar("creditcard")).toBe("XERO_ACCOUNT_CREDITCARD");
  });

  /**
   * The failure this shape exists to prevent, exercised the only way a runtime
   * test can: `zohoMode` is a fallback map where anything unrecognised becomes
   * `banktransfer`, and a resolver with a default would inherit that and post a
   * new rail's money to the bank account. The real guard is the `never` in the
   * default arm — a fourth `LedgerPaymentMode` stops this file compiling — but
   * a fourth rail smuggled past the type must still not resolve to a default.
   */
  it("has no default arm a new rail could fall into", () => {
    const rogue = "applepay" as unknown as Parameters<typeof xeroAccountEnvVar>[0];
    expect(() => xeroAccountEnvVar(rogue)).toThrow(LedgerError);
    expect(() => xeroAccountEnvVar(rogue)).not.toThrow(/BANKTRANSFER/);
  });
});

describe("xeroPaymentAccountId — fails closed, and names the variable", () => {
  it("returns the configured AccountID for the rail", () => {
    const env = { XERO_ACCOUNT_BANKTRANSFER: BANK, XERO_ACCOUNT_CREDITCARD: CLEARING };
    expect(xeroPaymentAccountId("banktransfer", env)).toBe(BANK);
    expect(xeroPaymentAccountId("creditcard", env)).toBe(CLEARING);
  });

  it("reads ONLY its own rail's variable — a configured bank account is not a fallback", () => {
    const env = { XERO_ACCOUNT_BANKTRANSFER: BANK };
    expect(() => xeroPaymentAccountId("creditcard", env)).toThrow(/XERO_ACCOUNT_CREDITCARD/);
    expect(() => xeroPaymentAccountId("creditcard", env)).not.toThrow(new RegExp(BANK));
  });

  /**
   * Not a hypothetical: the Demo Company has no cash-type account at all, so
   * this rail is genuinely unconfigurable there until the bootstrap creates one.
   * The honest answer is a refusal naming the variable, not the bank account.
   */
  it("refuses the cash rail while no cash account exists", () => {
    expect(() => xeroPaymentAccountId("cash", {})).toThrow(LedgerError);
    expect(() => xeroPaymentAccountId("cash", {})).toThrow(/XERO_ACCOUNT_CASH/);
  });

  it("treats whitespace as unset", () => {
    expect(() => xeroPaymentAccountId("banktransfer", { XERO_ACCOUNT_BANKTRANSFER: "   " })).toThrow(
      /XERO_ACCOUNT_BANKTRANSFER/,
    );
  });

  /** The likeliest operator error: the Chart of Accounts screen shows the Code. */
  it("rejects an account Code pasted where an AccountID belongs", () => {
    expect(() => xeroPaymentAccountId("banktransfer", { XERO_ACCOUNT_BANKTRANSFER: "090" })).toThrow(
      /must be a Xero AccountID \(a GUID\), not an account Code/,
    );
  });
});

describe("xeroCardEnabled — declared, and disabled by default", () => {
  it("is false when unset, because that is the safe direction", () => {
    expect(xeroCardEnabled({})).toBe(false);
  });

  it("is true only for an exact true", () => {
    expect(xeroCardEnabled({ XERO_CARD_ENABLED: "true" })).toBe(true);
    expect(xeroCardEnabled({ XERO_CARD_ENABLED: "TRUE" })).toBe(true);
    expect(xeroCardEnabled({ XERO_CARD_ENABLED: "1" })).toBe(false);
    expect(xeroCardEnabled({ XERO_CARD_ENABLED: "yes" })).toBe(false);
    expect(xeroCardEnabled({ XERO_CARD_ENABLED: "false" })).toBe(false);
  });
});

describe("xeroBrandingThemeId — a pricing decision that cannot be silently reversed", () => {
  /**
   * Peter, 2026-07-09: balance invoices are BACS/cash only because card fees are
   * too high at those values. Xero cannot suppress card per invoice, so the only
   * expression of that decision is the branding theme — and a quiet fallback to
   * the default theme would start charging those fees with nothing reporting it.
   */
  it("refuses to raise a no-card invoice under the ordinary theme when card is live", () => {
    const env = { XERO_CARD_ENABLED: "true", XERO_BRANDING_THEME_DEFAULT: THEME_STANDARD };
    expect(() => xeroBrandingThemeId({ disableOnlinePayments: true }, env)).toThrow(LedgerError);
    expect(() => xeroBrandingThemeId({ disableOnlinePayments: true }, env)).toThrow(
      /XERO_BRANDING_THEME_NO_CARD/,
    );
  });

  it("uses the card-suppressed theme when one is configured", () => {
    const env = {
      XERO_CARD_ENABLED: "true",
      XERO_BRANDING_THEME_DEFAULT: THEME_STANDARD,
      XERO_BRANDING_THEME_NO_CARD: THEME_NO_CARD,
    };
    expect(xeroBrandingThemeId({ disableOnlinePayments: true }, env)).toBe(THEME_NO_CARD);
    expect(xeroBrandingThemeId({ disableOnlinePayments: false }, env)).toBe(THEME_STANDARD);
  });

  /**
   * The way this goes wrong while looking deliberate: one theme id pasted into
   * both variables makes the suppression a no-op.
   */
  it("refuses when the two themes are the same theme", () => {
    const env = {
      XERO_CARD_ENABLED: "true",
      XERO_BRANDING_THEME_DEFAULT: THEME_STANDARD,
      XERO_BRANDING_THEME_NO_CARD: THEME_STANDARD,
    };
    expect(() => xeroBrandingThemeId({ disableOnlinePayments: true }, env)).toThrow(
      /suppressing card does nothing/,
    );
  });

  /**
   * With card DECLARED off in Xero, no theme in the org can offer a Pay Now
   * button, so `disableOnlinePayments` holds by construction and there is
   * nothing further to configure.
   */
  it("needs no theme configured once card is declared off", () => {
    expect(xeroBrandingThemeId({ disableOnlinePayments: true }, { XERO_CARD_ENABLED: "false" })).toBeUndefined();
    expect(
      xeroBrandingThemeId(
        { disableOnlinePayments: true },
        { XERO_CARD_ENABLED: "false", XERO_BRANDING_THEME_DEFAULT: THEME_STANDARD },
      ),
    ).toBe(THEME_STANDARD);
  });

  /**
   * The defect this test replaces. An earlier draft treated an UNSET
   * `XERO_CARD_ENABLED` as proof card was off — and unset is exactly the state
   * a cutover leaves it in, since the variable is new and in no runbook. If a
   * payment service is attached to the org's default theme (the ordinary reason
   * to attach one), every balance invoice would then quietly offer Pay Now and
   * charge the card fees Peter ruled out on 2026-07-09. Nothing could detect
   * it: the PaymentServices API is closed to non-certified partners, so a human
   * has to declare the state rather than the code assume it.
   */
  it("refuses to assume card is off when nobody has said so", () => {
    expect(() => xeroBrandingThemeId({ disableOnlinePayments: true }, {})).toThrow(
      /XERO_CARD_ENABLED[\s\S]*not set/,
    );
    expect(() =>
      xeroBrandingThemeId({ disableOnlinePayments: true }, { XERO_BRANDING_THEME_DEFAULT: THEME_STANDARD }),
    ).toThrow(/not set/);
  });

  it("leaves the theme to Xero when none is configured", () => {
    expect(xeroBrandingThemeId({}, {})).toBeUndefined();
    expect(xeroBrandingThemeId({ disableOnlinePayments: false }, {})).toBeUndefined();
  });

  it("rejects a theme id that is not a GUID", () => {
    expect(() => xeroBrandingThemeId({}, { XERO_BRANDING_THEME_DEFAULT: "Standard" })).toThrow(
      /must be a Xero BrandingThemeID/,
    );
  });
});

describe("xeroTaxType — OUTPUT is the trap", () => {
  const env = { XERO_TAX_TYPE_VAT: "OUTPUT2", XERO_TAX_TYPE_NO_VAT: "NONE" };

  it("returns the configured type for each treatment", () => {
    expect(xeroTaxType(true, env)).toBe("OUTPUT2");
    expect(xeroTaxType(false, env)).toBe("NONE");
  });

  it("names the missing variable rather than assuming a rate", () => {
    expect(() => xeroTaxType(true, {})).toThrow(/XERO_TAX_TYPE_VAT/);
    expect(() => xeroTaxType(false, {})).toThrow(/XERO_TAX_TYPE_NO_VAT/);
  });

  /**
   * `OUTPUT` is the string anyone would reach for, and on a UK organisation it
   * is the legacy 17.5% rate with `Status: DELETED`. An invoice raised on it
   * looks completely normal and charges the wrong VAT.
   */
  it("refuses the legacy 17.5% OUTPUT rate", () => {
    expect(() => xeroTaxType(true, { XERO_TAX_TYPE_VAT: "OUTPUT" })).toThrow(/LEGACY 17\.5% rate/);
    expect(() => xeroTaxType(true, { XERO_TAX_TYPE_VAT: "output" })).toThrow(LedgerError);
  });

  /** Only the VAT-bearing slot is policed — `OUTPUT` in the zero-VAT slot is a
   *  different mistake and one this check has no evidence about. */
  it("does not second-guess the zero-VAT type", () => {
    expect(xeroTaxType(false, { XERO_TAX_TYPE_NO_VAT: "ZERORATEDOUTPUT" })).toBe("ZERORATEDOUTPUT");
  });
});

describe("xeroOrgShortCode", () => {
  it("returns the configured short code", () => {
    expect(xeroOrgShortCode({ XERO_ORG_SHORTCODE: "!N7rJh" })).toBe("!N7rJh");
  });

  /**
   * `zohoInvoiceAppUrl` interpolates an empty org id and produces a link to
   * nowhere. This refuses instead: office staff clicking an "open in Xero"
   * button cannot tell a wrong org from a right one.
   */
  it("refuses to build a deep link with no organisation", () => {
    expect(() => xeroOrgShortCode({})).toThrow(/XERO_ORG_SHORTCODE/);
  });
});
