import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * /s/<token> — the storage signing page's payment-method sentence.
 *
 * STORAGE_PAYMENT_SENTENCE says "card" because the storage TERMS say card, but
 * the page rendered it unconditionally — including for a brand whose card
 * channel is off (the §11.10 two-switch verdict: global kill switch AND the
 * brand's own switch). That put "can be paid by ... card" on a Pitmans surface
 * whose every payment rail is bank-only. The mention is now gated on the LET's
 * brand's LIVE verdict (`cardPaymentsAvailable`), degrading to the no-card
 * sentence — the same fail-safe direction as lib/comms/quote-email.ts.
 *
 * Source guard (house convention for deep-IO pages — see
 * tests/lib/quote/small-job-settled-copy.test.ts): what is locked is
 * structural — the verdict is resolved for the let's own brand, and the
 * card-naming sentence is unreachable without it.
 */
const PAGE = readFileSync(join(process.cwd(), "app/s/[token]/page.tsx"), "utf8");

describe("/s storage signing page — the card mention is gated on the live card verdict", () => {
  it("resolves the two-switch verdict for the let's own brand", () => {
    expect(PAGE).toContain("cardPaymentsAvailable(");
    const call = PAGE.slice(PAGE.indexOf("cardPaymentsAvailable("));
    expect(call.slice(0, 80), "the verdict must be asked for the LET's brand").toContain("let_.brand");
  });

  it("renders the card sentence only behind the verdict, bank-only copy otherwise", () => {
    expect(PAGE).toContain("STORAGE_PAYMENT_SENTENCE_NO_CARD");
    expect(PAGE).toMatch(/cardOk\s*\?\s*STORAGE_PAYMENT_SENTENCE\s*:\s*STORAGE_PAYMENT_SENTENCE_NO_CARD/);
    // The old unconditional render must be gone.
    expect(PAGE).not.toMatch(/\{STORAGE_PAYMENT_SENTENCE\}/);
  });
});
