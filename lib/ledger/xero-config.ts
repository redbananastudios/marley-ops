/**
 * Org-specific Xero configuration — the ids that must never be hardcoded.
 *
 * Everything in this file names something that exists inside ONE Xero
 * organisation: a nominal account, a branding theme, a VAT rate, the org's own
 * short code. None of it is a property of the Xero API, so none of it can be a
 * constant in the source tree.
 *
 * Two independent reasons, and either alone would be sufficient:
 *
 *  1. **Staging and live are different organisations.** The Demo Company's
 *     `090 Business Bank Account` is `bd9e85e0-…`; Connor's real current account
 *     is some other GUID entirely. A hardcoded id is right on exactly one of the
 *     two environments and silently wrong on the other — and "wrong" here means
 *     real customer money booked to the wrong nominal account, which an
 *     accountant reverses with a VAT period attached.
 *  2. **The Demo Company resets every 28 days** (measured: the org behind the
 *     staging credentials was created 2026-08-27T21:10Z, so the first reset
 *     lands around 2026-09-24). The reset destroys the chart of accounts and the
 *     branding themes and mints new ids for the replacements. A hardcoded id is
 *     therefore wrong *on a schedule*, not merely by accident.
 *
 * ## The house rule this file implements
 *
 * **An unset value fails closed, with a message naming the environment variable
 * to set.** Never a default, never a first-row-from-`/Accounts`, never a guess.
 * Discovering the accounts at runtime was considered and rejected for the same
 * reason `firstTenantId` refuses a multi-org connection: the Demo Company alone
 * offers five payment-eligible accounts, two of which are EQUITY accounts
 * (`970 Owner A Funds Introduced`, `980 Owner A Drawings`) that would book a
 * customer receipt as an owner contribution. A plausible-looking wrong answer is
 * exactly what an automatic picker produces here.
 *
 * No IO and no `server-only`: this is `process.env` arithmetic, and
 * `invoiceAppUrl` has to be able to call {@link xeroOrgShortCode} synchronously
 * from inside a React render (`lib/ledger/types.ts` — "synchronous by contract").
 */
import type { LedgerPaymentMode } from "./types";
import { LedgerError } from "./types";

/** Just enough of an environment to read from — mirrors `xero-guard.ts`. */
type EnvLike = Record<string, string | undefined>;

/**
 * Xero's own identifiers are GUIDs. Checked rather than assumed because the
 * single most likely operator error here is pasting an account **Code** (`090`,
 * `855`) out of the Chart of Accounts screen, which is what that screen shows
 * and what most of Xero's own examples use.
 *
 * A Code in an AccountID slot fails at Xero with a validation error rather than
 * posting somewhere wrong, so this check buys clarity, not safety — an operator
 * gets told what they actually did instead of reading a Xero 400.
 */
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function read(env: EnvLike, name: string): string {
  return (env[name] ?? "").trim();
}

/**
 * The environment variable holding the Xero account for one payment rail.
 *
 * **An exhaustive `switch` with a `never` guard, deliberately** — not a lookup
 * object with a fallback and not a ternary chain (design §12.2). `zohoMode` at
 * `accept-flow.ts:1290` is a fallback map: anything that is not cash or card
 * becomes `banktransfer`. That is correct today only because the input unions
 * are closed, and a fourth rail added next year would inherit the fallback and
 * post customer money to the bank account instead of failing to compile.
 *
 * Adding a fourth `LedgerPaymentMode` must break the build here. That is the
 * whole point of the shape.
 */
export function xeroAccountEnvVar(mode: LedgerPaymentMode): string {
  switch (mode) {
    case "banktransfer":
      return "XERO_ACCOUNT_BANKTRANSFER";
    case "cash":
      return "XERO_ACCOUNT_CASH";
    case "creditcard":
      return "XERO_ACCOUNT_CREDITCARD";
    default: {
      // Unreachable while `LedgerPaymentMode` is the closed union it is today.
      // If this line stops compiling, a rail was added without deciding which
      // nominal account its money lands in — decide that, do not delete this.
      const unhandled: never = mode;
      throw new LedgerError(
        `No Xero account is configured for payment mode "${String(unhandled)}". ` +
          `Every payment rail must name its own nominal account before it can be used.`,
      );
    }
  }
}

/**
 * The Xero **AccountID** a payment on `mode` posts to.
 *
 * `PUT /Payments` names an ACCOUNT; the Payment schema has no method or mode
 * field at all (design §3). So the rail the customer used is expressed purely by
 * which account the money lands in, and this mapping is the only thing standing
 * between a BACS receipt and the petty-cash ledger.
 *
 * **AccountID, not Code.** Xero accepts either, but its own documentation says
 * "not all accounts have a code value" and Code is freely editable in the Chart
 * of Accounts UI — a bookkeeper renumbering the chart would silently re-point a
 * rail. AccountID is the stable id, which is also what `context/rules.md`'s
 * "look a record up by its stable id" requires.
 *
 * Known gap, recorded rather than worked around: **the Demo Company has no
 * cash-type account at all** (probed live 2026-08-28 — zero accounts matching
 * cash/petty/till/float, and the only two `Type=BANK` accounts are the current
 * and savings accounts). So the `cash` rail cannot be exercised on staging until
 * the demo bootstrap creates one. Until then this throws for `cash`, which is
 * the correct behaviour: no account exists, so there is no honest answer.
 */
export function xeroPaymentAccountId(
  mode: LedgerPaymentMode,
  env: EnvLike = process.env,
): string {
  const name = xeroAccountEnvVar(mode);
  const value = read(env, name);
  if (!value) {
    throw new LedgerError(
      `No Xero account is configured for "${mode}" payments — set ${name} to the ` +
        `AccountID (a GUID) of the nominal account that rail's money lands in. ` +
        `Refusing to guess: the wrong account books real customer money against the ` +
        `wrong nominal, and two of the Demo Company's payment-eligible accounts are ` +
        `owner-equity accounts.`,
    );
  }
  if (!GUID.test(value)) {
    throw new LedgerError(
      `${name} must be a Xero AccountID (a GUID), not an account Code — got "${value}". ` +
        `The Chart of Accounts screen shows the Code; the AccountID comes from ` +
        `GET /Accounts. Code is user-editable and not all accounts have one.`,
    );
  }
  return value;
}

/**
 * Whether an online card payment service is attached in Xero at all.
 *
 * **This is config-declared, not detected.** Xero exposes payment-service state
 * through the PaymentServices API, and that endpoint is closed to us: "payment
 * service details can only be accessed by specifically certified payment service
 * partners" (design §12.1). So the integration cannot ask Xero whether card is
 * live; a human tells it, once, in `app.env`.
 *
 * **The default is disabled, because that is the safe direction.** If card is
 * genuinely off in Xero and we believe it is off, everything is consistent. If
 * card is genuinely off and we believe it is ON, we merely demand a branding
 * theme that suppresses something which was never offered — noisy, harmless,
 * and fixed by one variable. The dangerous direction is the other one, and it
 * cannot arise from an *unset* variable.
 *
 * Exact `"true"` only, mirroring `liveWritesAllowed` in `xero-guard.ts`: a value
 * of `"1"`, `"yes"` or `"True-ish"` is a typo, not a decision.
 */
export function xeroCardEnabled(env: EnvLike = process.env): boolean {
  return read(env, "XERO_CARD_ENABLED").toLowerCase() === "true";
}

/**
 * The `BrandingThemeID` an invoice is raised under, or `undefined` to let Xero
 * apply the organisation's own default theme.
 *
 * ## Why a branding theme decides whether a customer can pay by card
 *
 * `CreateInvoiceInput.disableOnlinePayments` exists because **balance invoices
 * are BACS/cash only — card fees are too high at those values** (Peter,
 * 2026-07-09). That is a pricing decision, not a technical preference.
 *
 * Zoho honours it per invoice (`payment_options.payment_gateways: []`). Xero has
 * no per-invoice equivalent whatsoever: online payment services attach to a
 * **BrandingTheme**, and an invoice selects a theme. So "this invoice must not
 * be payable by card" can only be expressed as "raise it under a theme that has
 * no payment service attached" (design §2).
 *
 * ## Why this refuses rather than falling back
 *
 * The failure this shape prevents is the silent reversal of that pricing
 * decision. If `disableOnlinePayments: true` quietly fell back to the default
 * theme when no suppressed theme was configured, every balance invoice would
 * start offering a Pay Now button and start paying card fees — with nothing
 * anywhere reporting that the flag had stopped being honoured. The person who
 * decided card was too expensive would find out from the merchant statement.
 *
 * So the two states are:
 *
 *  - **Card not enabled in Xero** (`XERO_CARD_ENABLED` unset or not `"true"`):
 *    `disableOnlinePayments` is satisfied **by construction** — no theme in the
 *    org can offer a payment button, so any theme suppresses card. Nothing to
 *    configure, and §2's "two themes per brand" migration is not needed at all.
 *  - **Card enabled**: a `disableOnlinePayments: true` invoice REQUIRES a
 *    configured card-suppressed theme, and throws naming the variable when
 *    there isn't one.
 *
 * The last check — that the two ids differ — closes the way this goes wrong
 * while looking configured: pasting the same theme id into both variables makes
 * the suppression a no-op, and every balance invoice would offer card while the
 * config reads as deliberate.
 */
export function xeroBrandingThemeId(
  input: { disableOnlinePayments?: boolean },
  env: EnvLike = process.env,
): string | undefined {
  const fallback = read(env, "XERO_BRANDING_THEME_DEFAULT");
  if (fallback) requireThemeId("XERO_BRANDING_THEME_DEFAULT", fallback);

  if (!input.disableOnlinePayments) return fallback || undefined;

  const declared = read(env, "XERO_CARD_ENABLED").toLowerCase();
  if (declared === "false") {
    // DECLARED off org-wide, so no theme can offer a Pay Now button and the
    // caller's intent already holds. Returning the ordinary theme keeps the
    // invoice looking like every other one.
    return fallback || undefined;
  }
  if (declared !== "true") {
    // UNSET is not evidence. This function's first draft treated absent and
    // "false" alike, on the reasoning that the dangerous direction could not
    // arise from an unset variable — which is backwards, and two independent
    // reviewers caught it. Unset is precisely the state this arrives in: the
    // variable is new, so a cutover that sets LEDGER_PROVIDER, the account ids
    // and the tax types will leave it empty. If a payment service is attached
    // to the org's default theme — the ordinary reason to attach one at all —
    // every balance invoice would then quietly offer Pay Now and charge the
    // card fees Peter ruled out on 2026-07-09, with nothing to notice it but
    // the merchant statement. The PaymentServices API is closed to
    // non-certified partners, so we cannot ask Xero; a human has to say.
    throw new LedgerError(
      `This invoice must not be payable by card (balance invoices are BACS/cash only — ` +
        `card fees are too high at those values, Peter 2026-07-09), and XERO_CARD_ENABLED ` +
        `is not set, so nothing here knows whether Xero can take one. Set it to "false" to ` +
        `declare that no branding theme in the org has a payment service attached, or to ` +
        `"true" plus XERO_BRANDING_THEME_NO_CARD. Refusing to assume: an unset variable is ` +
        `not evidence, and guessing wrong reverses a pricing decision silently.`,
    );
  }

  const suppressed = read(env, "XERO_BRANDING_THEME_NO_CARD");
  if (!suppressed) {
    throw new LedgerError(
      `This invoice must not be payable by card (balance invoices are BACS/cash only — ` +
        `card fees are too high at those values, Peter 2026-07-09), but XERO_CARD_ENABLED ` +
        `is true and XERO_BRANDING_THEME_NO_CARD is not set. Xero can only suppress card ` +
        `per branding theme, so set that variable to the BrandingThemeID of a theme with ` +
        `no payment service attached. Refusing to raise it under the default theme, which ` +
        `would silently start charging card fees on every balance invoice.`,
    );
  }
  requireThemeId("XERO_BRANDING_THEME_NO_CARD", suppressed);

  if (fallback && fallback.toLowerCase() === suppressed.toLowerCase()) {
    throw new LedgerError(
      `XERO_BRANDING_THEME_NO_CARD and XERO_BRANDING_THEME_DEFAULT are the same theme ` +
        `(${suppressed}), so suppressing card does nothing. They must be two different ` +
        `branding themes: one with a payment service attached, one without.`,
    );
  }
  return suppressed;
}

function requireThemeId(name: string, value: string): void {
  if (!GUID.test(value)) {
    throw new LedgerError(
      `${name} must be a Xero BrandingThemeID (a GUID) — got "${value}". The ids come ` +
        `from GET /BrandingThemes and change on every Demo Company reset.`,
    );
  }
}

/**
 * The Xero `TaxType` string for a line, given whether it carries VAT.
 *
 * ## Why this is configuration and not a constant
 *
 * `OUTPUT` is the obvious-looking string, it is what scanning a UK org's tax
 * rates surfaces first, and **it is 17.5% and `Status: DELETED`** (measured on
 * the Demo Company, 2026-08-28). The 20% rate is `OUTPUT2`. `SROUTPUT` is 15%,
 * also DELETED. Reaching for the intuitive name — or deriving "the output rate"
 * by matching on the word OUTPUT — books VAT at 17.5% on a real customer
 * invoice, and the invoice looks entirely normal.
 *
 * The Demo Company alone carries four historic output rates at three different
 * percentages. That is also exactly why `CreateCreditNoteInput.applyVat`
 * **mirrors the original invoice** instead of re-deriving from the org's current
 * rate: the org's current rate is not necessarily the rate the invoice was
 * raised at, and a credit note that reverses a different percentage than it
 * credits leaves a VAT discrepancy for an accountant to chase.
 *
 * `applyVat: false` maps to the org's explicit no-VAT type (`NONE` on both
 * orgs), not to omitting the field: an omitted TaxType inherits the account's
 * default rate, which is the 20% one.
 *
 * Note that `NONE` ("No VAT") is semantically different from `ZERORATEDOUTPUT`,
 * `EXEMPTOUTPUT` and the EC variants, which are all 0% but report differently on
 * a VAT return. They are not interchangeable — if a case ever needs one, it gets
 * its own variable rather than being folded in here.
 */
export function xeroTaxType(applyVat: boolean, env: EnvLike = process.env): string {
  const name = applyVat ? "XERO_TAX_TYPE_VAT" : "XERO_TAX_TYPE_NO_VAT";
  const value = read(env, name);
  if (!value) {
    throw new LedgerError(
      `No Xero TaxType is configured for ${applyVat ? "VAT-bearing" : "zero-VAT"} lines — ` +
        `set ${name}. On a UK organisation these are OUTPUT2 (20% VAT on Income) and NONE ` +
        `(No VAT); confirm against GET /TaxRates for the org rather than assuming, and ` +
        `note that TaxType strings differ by Xero region.`,
    );
  }
  if (applyVat && value.toUpperCase() === "OUTPUT") {
    // Refused rather than warned. This is the one wrong value that looks right,
    // costs nothing to type, and produces invoices that are correct in every
    // respect except the number the customer is charged.
    throw new LedgerError(
      `XERO_TAX_TYPE_VAT is set to "OUTPUT", which on a UK Xero organisation is the ` +
        `LEGACY 17.5% rate and is Status=DELETED — not the 20% rate. The 20% output rate ` +
        `is OUTPUT2. Set that, or a rate confirmed from GET /TaxRates with Status=ACTIVE, ` +
        `CanApplyToRevenue=true and DisplayTaxRate=20.`,
    );
  }
  return value;
}

/**
 * The organisation's `ShortCode` — the org segment of an "open in Xero" link.
 *
 * `invoiceAppUrl` is **synchronous by contract** (`lib/ledger/types.ts`): it is
 * called inside `.map()` in a non-async component at `/finance`. The short code
 * only exists on `GET /Organisation`, an async call, so it cannot be fetched at
 * render time and has to be configuration — the same shape `zohoInvoiceAppUrl`
 * uses for `ZOHO_ORG_ID`.
 *
 * Unlike that function, this one refuses when unset instead of interpolating an
 * empty string into the URL. A link built from a missing org id is not a
 * degraded link, and the office staff clicking it have no way to tell. The short
 * code also changes on every Demo Company reset, so "unset" and "stale" are both
 * live states this has to be able to surface.
 *
 * A caller rendering inside JSX must decide what a missing link looks like
 * (render no button) rather than letting this throw through a render.
 */
export function xeroOrgShortCode(env: EnvLike = process.env): string {
  const value = read(env, "XERO_ORG_SHORTCODE");
  if (!value) {
    throw new LedgerError(
      `XERO_ORG_SHORTCODE is not set, so no Xero deep link can be built. It is ` +
        `Organisation.ShortCode from GET /Organisation (e.g. "!N7rJh"), and it changes ` +
        `every time the Demo Company resets.`,
    );
  }
  return value;
}
