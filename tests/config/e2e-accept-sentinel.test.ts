import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Guard over the e2e accept-flow sentinels (QA-20260902-01).
 *
 * Since PR #181 the SENT-state /q page renders "pay by bank transfer on the
 * next screen…" whenever card payments are off — and on staging the global
 * `business_settings.card_payments_enabled` is false, so it always does. That
 * makes /Pay by bank transfer/i visible BEFORE the accept completes: a spec
 * that uses it as its "landed on the pay screen" signal passes the wait the
 * instant the button is clicked, reads the DB while `acceptQuoteOnline` is
 * still in flight, sees `status: "sent"`, fails, and its teardown then runs
 * under the still-inserting action and strands the marker fixture behind an
 * FK. `customer-accept-to-bookings.spec.ts` failed five straight CI runs
 * exactly this way while the app was fine.
 *
 * The only copy that proves the accept landed is the accepted pay screen's
 * own "deposit to secure your date" — it renders in no other /q state. So,
 * mechanically, for every e2e spec that CLICKS the accept button:
 *
 *   1. the click goes through `submitUntil` (the pre-hydration guard), never
 *      a bare `.click()` whose outcome nothing owns;
 *   2. no `submitUntil` uses the ambiguous bank-transfer copy as `expected`;
 *   3. the post-accept sentinel "deposit to secure your date" is what the
 *      spec waits on.
 *
 * Asserting the button's ABSENCE (the commercial gate) is fine and exempt —
 * only driving it is regulated. A text scan is enough here: the properties
 * are per-file string facts, not structural claims about bindings.
 */

const E2E_ROOT = join(process.cwd(), "e2e");
const ACCEPT_BUTTON = "Accept quote & pay";

function specFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...specFiles(path));
    else if (name.endsWith(".spec.ts")) out.push(path);
  }
  return out;
}

/** True when the file drives the accept button, not merely asserts on it. */
function clicksAcceptButton(src: string): boolean {
  // Every locator for the button is built from its accessible name; a file
  // that only checks visibility/absence never passes that locator to a click
  // path (`.click()` or a submitUntil `click:` entry).
  if (!src.includes(ACCEPT_BUTTON)) return false;
  return /click[:(][^\n]*Accept quote & pay|Accept quote & pay[^\n]*\}\s*\)\s*\.click\(/.test(src);
}

describe("e2e accept-flow sentinels", () => {
  const accepting = specFiles(E2E_ROOT)
    .map((path) => ({ path, src: readFileSync(path, "utf8") }))
    .filter(({ src }) => clicksAcceptButton(src));

  it("finds the accept-driving specs (the guard is not scanning thin air)", () => {
    // customer.spec.ts and customer-accept-to-bookings.spec.ts both drive the
    // button today; if this ever drops to zero the glob or the button copy
    // changed and the guard is dead, not passing.
    expect(accepting.length).toBeGreaterThanOrEqual(2);
  });

  it.each(accepting.map(({ path, src }) => [path.slice(E2E_ROOT.length + 1), src] as const))(
    "%s drives the accept button through submitUntil onto post-accept-only copy",
    (_rel, src) => {
      // 1. No bare `.click()` on the accept button — submitUntil owns the click.
      expect(
        /Accept quote & pay[^\n]*\}\s*\)\s*\.click\(/.test(src),
        "the accept button must be clicked via submitUntil, never a bare .click()",
      ).toBe(false);
      expect(src, "accept-driving specs must use submitUntil").toContain("submitUntil(");

      // 2. The ambiguous copy is never a landed sentinel: since #181 the
      //    card-off SENT page renders it pre-accept.
      expect(
        /expected:[^\n]*Pay by bank transfer/i.test(src),
        '"Pay by bank transfer" renders pre-accept when cards are off — it must not be a submitUntil `expected`',
      ).toBe(false);

      // 3. The spec waits on the accepted pay screen's own copy.
      expect(src, "the post-accept wait must target the accepted screen's own copy").toContain(
        "deposit to secure your date",
      );
    },
  );
});
