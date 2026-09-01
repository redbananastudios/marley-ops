import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The accept screen promised a payment rail the next screen would not offer.
 *
 * `/q` resolves `cardOk` — the AND of the gateway credentials, the global kill
 * switch and the brand's own switch — and correctly gates the pay-by-card
 * BUTTON on it. The sentence above the Accept button did not: it said the
 * deposit could be paid "by card or bank transfer on the next screen"
 * unconditionally. A customer of a bank-transfer-only brand was therefore told
 * they could pay by card, accepted on that basis, and landed on a screen with
 * no such button on it.
 *
 * The residential branch is the one that reaches it. The only earlier
 * sent-state return is the commercial one, so nothing stopped a residential
 * quote on a rail-less brand from rendering that promise.
 *
 * Asserted against the SOURCE rather than a render: this is a server component
 * whose every branch sits behind an awaited Supabase read, and the property
 * that matters — no unconditional promise anywhere in the file — belongs to
 * the whole file rather than to one happy path. Same technique
 * `brand-page-theme.test.ts` uses on this page, for the same reason.
 */

const page = readFileSync(join(process.cwd(), "app/q/[token]/page.tsx"), "utf8");

/**
 * Comments legitimately name the rail while explaining the mechanism, so only
 * rendered copy is in scope. Blanked rather than deleted so offsets into the
 * stripped text still line up with the real file.
 */
const stripComments = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));

const copy = stripComments(page).replace(/\s+/g, " ");

describe("/q accept screen — card is promised only where card is live", () => {
  /**
   * The defect, stated as a shape rather than as a string: the promise used to
   * be bare JSX text, which renders unconditionally. Inside a quoted string it
   * can only reach the page through a branch, and the only branch here is the
   * flag. This survives a rewording; a `toContain` on the old sentence would
   * not.
   */
  it("never renders the card promise as unconditional JSX text", () => {
    const hits = [...copy.matchAll(/pay by card or bank transfer/g)];
    expect(hits.length, "the card promise has gone entirely").toBeGreaterThan(0);
    for (const hit of hits) {
      expect(
        copy[hit.index - 1],
        "the card promise is bare JSX text, so every brand renders it",
      ).toBe('"');
    }
  });

  it("puts the promise on the true arm of the cardOk flag", () => {
    expect(copy).toMatch(/cardOk \? "pay by card or bank transfer on the next screen\./);
  });

  it("still offers card where the flag allows it", () => {
    // The fix must condition the rail, not delete it — a brand whose card
    // channel is live keeps the wording its customers read today.
    expect(copy).toContain("pay by card or bank transfer on the next screen.");
  });

  it("gives the card-off path a real instruction, not a hedge", () => {
    // "(where available)" and friends would technically stop the lie while
    // leaving the customer no idea what to actually do. Bank transfer has to
    // read as the path, with the phone as a genuine second route — the deposit
    // screen this sentence describes ends with "Prefer to sort it by phone?".
    expect(copy).not.toMatch(/where available/i);
    expect(copy).toContain("pay by bank transfer on the next screen");
  });

  /**
   * The button was always right; it is the copy that drifted. If a later
   * change ungates the button, the two disagree again in the other direction.
   */
  it("still gates the card button on the same flag", () => {
    expect(copy).toContain("{cardOk ? ( <> <PayCardButton");
  });
});
