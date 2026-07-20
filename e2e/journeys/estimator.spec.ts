import { test } from "@playwright/test";

/**
 * Estimator journey (PRD B2): lead → assigned → survey → quote built → sent →
 * follow-up → converted. Runs in the "estimator" project (estimator storageState).
 * Fixme outline — fill against staging.
 */
test.describe("Estimator — lead to conversion", () => {
  test("builds and sends a quote from an assigned survey", async () => {
    test.fixme(
      true,
      [
        "Steps to implement against staging:",
        "1. /estimator → the assigned seeded survey (SEED.freshEnquiry) is listed.",
        "2. Open the lead → build a quote in the wizard (rooms/volume or manual), priced.",
        "3. Send the quote → a quote email lands in the sink (capture HTML); the lead moves to 'quoted/sent'.",
        "4. Assert the quote PDF opens and itemises to the subtotal with VAT at the inclusive rate.",
      ].join("\n"),
    );
  });
});
