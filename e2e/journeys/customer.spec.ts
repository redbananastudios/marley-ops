import { test } from "@playwright/test";

/**
 * Customer journey (PRD B2): enquiry → quote → accept → deposit → confirmation →
 * reminder → move day → balance invoice → receipt.
 *
 * Public pages (/q/<token>, /s/<token>) — no auth (the "public" project). Needs
 * the seeded quote token + the takepayments sandbox for the deposit leg. Written
 * as a fixme outline; fill selectors + assertions against staging.
 */
test.describe("Customer — enquiry to receipt", () => {
  test("accepts a quote and pays the deposit (sandbox), then receives confirmation", async () => {
    test.fixme(
      true,
      [
        "Steps to implement against staging:",
        "1. GET /q/<seeded-token> → the quote renders with the correct total + deposit.",
        "2. Accept online → the acceptance strip confirms; a booking-confirmation email lands in the sink (capture HTML to /artefacts).",
        "3. Pay-by-card (sandbox approved) → deposit receipt email; /finance shows a -DEP invoice.",
        "4. Assert no unresolved placeholders in any email (no 'undefined', no {{tokens}}), £1,800.00 currency, UK dates.",
      ].join("\n"),
    );
  });
});
