import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Gate 10b — the office's confirm dialog must describe what it is about to do.
 *
 * This button is the ONLY route by which a commercial booking can be confirmed:
 * PRD §3.10 gives commercial no accept action on /q and takes no signature, so
 * the office does it here. The server already behaved correctly — writes
 * deposit 0, sends no deposit email, arms no chase, logs "business terms" — but
 * the dialog went on describing the residential machine: "the customer gets an
 * email with their deposit payment link, the deposit invoice is raised in
 * Zoho". It also demanded a deposit "to request" that the server discards, and
 * REFUSED TO PROCEED on 0, which is the honest answer for a commercial job.
 *
 * Asserted as source guards, following tests/lib/quote/commercial-safety.test.ts
 * and the house convention in tests/components: this repo has no jsdom/RTL
 * setup (vitest runs `environment: 'node'`), and the properties worth locking
 * are structural — a field is gated, a validation is scoped, a button is
 * disabled until a value is known.
 *
 * Every lookup goes through `at()`, which FAILS on a missing needle. A bare
 * indexOf returns -1, and -1 compares "before" everything, so an ordering
 * assertion over two missing strings passes while proving nothing — the exact
 * way a guard in this repo went vacuous once already.
 */

const DIALOG = readFileSync(
  join(process.cwd(), "components/quote/accept-quote-button.tsx"),
  "utf8",
);
const ACTIONS = readFileSync(
  join(process.cwd(), "app/(dashboard)/quotes/actions.ts"),
  "utf8",
);

const at = (haystack: string, needle: string, what: string): number => {
  const i = haystack.indexOf(needle);
  expect(i, `no longer contains ${what}`).toBeGreaterThan(-1);
  return i;
};

describe("the office confirm dialog knows which ladder it is confirming", () => {
  it("resolves the policy itself on open, rather than trusting a caller to pass it", () => {
    // The quotes LIST is the case that forces this. Its rows carry no client
    // join, and `quotes.payment_policy` is null on every unaccepted quote — so
    // there is nothing on a list row this could have been read from, and a
    // prop-only design would have been correct on the detail page and wrong on
    // the list, which is the harder failure to notice.
    at(DIALOG, "quotePaymentPolicy(quoteId)", "the on-open policy fetch");
    at(DIALOG, "if (!open || paymentPolicy) return;", "the fetch's open/seed guard");
  });

  it("stays un-actionable until the policy is known", () => {
    at(DIALOG, "disabled={busy || !resolved}", "the confirm button's unresolved-policy guard");
    at(DIALOG, '"Checking terms…"', "the checking label");
    // `resolved` must mean BOTH real policies and nothing else — a definition
    // that admitted "failed" or null would make the guard above decorative.
    at(
      DIALOG,
      'const resolved = policy === "residential" || policy === "commercial";',
      "the resolved definition",
    );
  });

  it("refuses to guess when the policy cannot be read", () => {
    // Falling back to residential on a failed read is the dangerous default:
    // it shows a deposit field for a business client and emails them a payment
    // demand. Failing closed here means the office sees an error instead.
    at(DIALOG, 'setPolicy("failed")', "the failed-read state");
    at(DIALOG, '"Unavailable"', "the failed-read button label");
    expect(
      DIALOG,
      "a failed policy read must never resolve to a usable policy",
    ).not.toMatch(/setPolicy\((["'])residential\1\)/);
  });
});

describe("commercial takes no deposit, and the dialog says so", () => {
  it("renders no deposit field at all on the commercial ladder", () => {
    const gate = at(DIALOG, "{commercial ? null : (", "the deposit field's commercial gate");
    const field = at(DIALOG, 'id="accept-deposit"', "the deposit input");
    // The gate must OPEN before the field, or the field is outside it.
    expect(gate).toBeLessThan(field);
  });

  it("scopes the deposit validation so 0 is not a blocker", () => {
    const start = at(DIALOG, "async function confirm()", "the confirm handler");
    const end = DIALOG.indexOf("return (", start);
    expect(end, "confirm handler has no end").toBeGreaterThan(start);
    const body = DIALOG.slice(start, end);

    const scope = at(body, "if (!commercial) {", "the validation's commercial scope");
    const askGuard = at(body, '"Enter the deposit to request."', "the deposit-required guard");
    const lessGuard = at(body, '"The deposit must be less than the agreed price."', "the deposit<price guard");
    // Both residential guards must sit INSIDE the scope. Outside it, a
    // commercial confirm hits "Enter the deposit to request." on the honest
    // value and cannot proceed at all.
    expect(askGuard).toBeGreaterThan(scope);
    expect(lessGuard).toBeGreaterThan(scope);
  });

  it("passes no deposit to the server on the commercial path", () => {
    // `dep` is left undefined, so acceptQuoteByStaff applies its own rule
    // rather than being handed a figure to discard.
    at(DIALOG, "let dep: number | undefined;", "the optional deposit binding");
    at(DIALOG, "acceptQuote(quoteId, value, dep)", "the accept call");
  });

  it("promises nothing it does not do — no email, no invoice, no Provisional", () => {
    const start = at(DIALOG, "{commercial ? (", "the commercial dialog description");
    // Searched FROM `start`, not from 0: `") : ("` occurs earlier in the file,
    // and a whole-file indexOf returned an end BEFORE the start, silently
    // slicing to "" — which every `toContain` below then failed on. It found
    // the bug in the test rather than hiding it, which is the point of `at()`,
    // but the lookup still has to be anchored.
    const end = DIALOG.indexOf(") : (", start);
    expect(end, "the description has no residential branch").toBeGreaterThan(start);
    const commercialCopy = DIALOG.slice(start, end);
    expect(commercialCopy).toContain("nothing is sent to the customer");
    expect(commercialCopy).toContain("due on their agreed terms");
    // The residential promises must not survive into the commercial branch.
    expect(commercialCopy.toLowerCase()).not.toContain("deposit payment");
    expect(commercialCopy).not.toContain("Provisional");
    expect(commercialCopy).not.toContain("Zoho");
  });

  it("still shows the residential dialog its own copy — the branch is not a deletion", () => {
    // Without this, every assertion above would pass against a dialog that had
    // simply lost its residential description.
    at(DIALOG, "the deposit invoice is raised in Zoho", "the residential description");
    at(DIALOG, '"Accept & request deposit"', "the residential confirm label");
    at(DIALOG, "Standard is {gbp(depositAmount)}", "the residential deposit hint");
  });
});

describe("quotePaymentPolicy reads the right source", () => {
  const body = () => {
    const start = at(ACTIONS, "export async function quotePaymentPolicy(", "the policy action");
    const end = ACTIONS.indexOf("export async function", start + 10);
    expect(end, "policy action has no end").toBeGreaterThan(start);
    return ACTIONS.slice(start, end);
  };

  it("resolves LIVE when the snapshot column is null", () => {
    // Null is the state of every draft and sent quote — the entire set this
    // dialog acts on — so a column-only read would call them all residential.
    expect(body()).toContain("await snapshotPaymentPolicy(sb, quote)");
  });

  it("prefers the snapshot column once it exists", () => {
    // An accepted quote must report the ladder it actually took, not the one
    // its client would be given today.
    expect(body()).toContain("quote.payment_policy");
    expect(body()).toContain("policyOfQuote(quote)");
  });

  it("requires a signed-in user", () => {
    expect(body()).toContain('if (!userId) return { ok: false as const, error: "Not signed in" };');
  });
});
