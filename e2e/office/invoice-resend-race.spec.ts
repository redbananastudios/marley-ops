import { test, expect, type Locator, type Page } from "@playwright/test";
import { step } from "../fixtures/artefacts";
import { openDialog } from "../fixtures/ui";
import { SEED } from "../fixtures/seed-data";
import {
  E2E_DB_READY,
  clearPayment,
  jobByQuoteRef,
  landPayment,
  paidStamps,
  type PayRail,
  type SeededJob,
} from "../fixtures/db";

/**
 * "Send it again" vs the customer who pays while the dialog is open.
 *
 * Every re-send dialog is populated when it OPENS. If the money lands in the gap
 * before the operator presses Send, the dialog is describing a world that no
 * longer exists, and sending would email a settled customer a demand for money
 * they have already handed over — they ring up angry, or they pay twice.
 *
 * The guard is that the refusal ladder (lib/payments/invoice-resend.ts) re-runs
 * SERVER-SIDE at the moment Send is pressed, not only when the dialog opens. This
 * spec drives that race on all THREE rails. Only the balance rail had ever been
 * browser-verified; the deposit and 25% commitment rails were built afterwards
 * and shipped unproven against this failure.
 *
 * WHAT WOULD MAKE THIS SPEC WORTHLESS, and how each is ruled out:
 *  - a dialog that never opened → the arrange step asserts the Send button is
 *    VISIBLE and the invoice number + quote ref are on screen, before any payment;
 *  - a page that errored blank → every assertion is scoped to a locator carrying
 *    this job's own unique quote ref (or invoice number), never `.first()`;
 *  - a send that failed for some OTHER reason → the toast must carry that rail's
 *    EXACT refusal sentence, so "the email did not send" cannot pass as a refusal;
 *  - a send that actually went out → the dialog closes on success, so a dialog
 *    still open, showing the invoice as paid, is proof the server said no.
 *
 * Mutation-verified 2026-08-21: with the `if (!verdict.ok) return` re-check
 * removed from resendDepositInvoiceFlow / resendCommitmentInvoiceFlow /
 * resendBalanceInvoiceFlow, all three tests FAIL. Restored, all three pass.
 */

/** The rails' refusal sentences, verbatim from lib/payments/invoice-resend.ts +
 *  lib/payments/balance-resend.ts. Hard-coded on purpose: the wording is what
 *  the office reads, so changing it should have to be a deliberate act that
 *  updates this spec too. */
const REFUSAL = {
  deposit: "The deposit is already paid — nothing to send.",
  commitment: "The commitment is already paid — nothing to send.",
  balance: "The balance is already paid — nothing to send.",
} as const;

/** The sonner toast carrying a specific message (page-level, so match on text). */
const toastSaying = (page: Page, text: string): Locator =>
  page.locator("[data-sonner-toast]").filter({ hasText: text });

const sendAgain = (dialog: Locator): Locator =>
  dialog.getByRole("button", { name: /^Send again to / });

test.describe("Office — an invoice re-send refuses a customer who paid mid-dialog", () => {
  test.skip(
    !E2E_DB_READY,
    "Needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (the CI e2e job exports both). Without them the mid-dialog payment cannot be staged and the concurrency guard is NOT verified by this run.",
  );

  /** Set by each test the moment it stages a payment, so cleanup is unconditional. */
  let pending: { job: SeededJob; rail: PayRail } | null = null;

  test.afterEach(async () => {
    if (!pending) return;
    const { job, rail } = pending;
    pending = null;
    await clearPayment(job, rail);
    // Verified by querying, not assumed: a silently-failed revert would leave the
    // next run's arrange step facing an already-paid job and quietly rot the spec.
    expect(
      await paidStamps(job, rail),
      `the ${rail} stamp on ${job.quoteRef} must be cleared for the next run`,
    ).toEqual({ quote: null, lead: null });
  });

  test("deposit — the deposit lands while the dialog is open", async ({ page }) => {
    const seed = SEED.resendRaceDeposit;
    const job = await jobByQuoteRef(seed.quoteRef);
    const dialog = page.getByRole("dialog").filter({ hasText: seed.quoteRef });

    await step("the deposit is raised, unpaid, and the office may send it again", page, async () => {
      await page.goto(`/leads/${job.leadId}`);
      await expect(page.getByRole("heading", { name: seed.name })).toBeVisible();
      await openDialog(page, page.getByRole("button", { name: "Deposit invoice" }));
      // The dialog is OUR job's and it loaded: its quote ref, its invoice number,
      // and a live Send button. A blank or errored dialog satisfies none of these.
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(seed.invoiceNumber);
      await expect(sendAgain(dialog)).toBeVisible();
      await expect(dialog.getByRole("alert")).toHaveCount(0);
    });

    await step("the customer pays — the open dialog knows nothing about it", page, async () => {
      pending = { job, rail: "deposit" };
      await landPayment(job, "deposit");
      // The stale dialog is still offering to ask them for money.
      await expect(sendAgain(dialog)).toBeVisible();
    });

    await step("Send is refused server-side and the dialog corrects itself", page, async () => {
      await sendAgain(dialog).click();
      // The server's own words, not merely "an error happened".
      await expect(toastSaying(page, REFUSAL.deposit)).toBeVisible({ timeout: 30_000 });
      // Still open (a successful send closes it) and now showing the refusal.
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("alert")).toHaveText(REFUSAL.deposit, { timeout: 20_000 });
      await expect(dialog).toContainText(seed.invoiceNumber);
      await expect(sendAgain(dialog)).toHaveCount(0);
    });
  });

  test("commitment (25%) — the commitment lands while the dialog is open", async ({ page }) => {
    const seed = SEED.resendRaceCommitment;
    const job = await jobByQuoteRef(seed.quoteRef);
    const dialog = page.getByRole("dialog").filter({ hasText: seed.quoteRef });

    await step("the 25% is raised, unpaid, and the office may send it again", page, async () => {
      await page.goto(`/leads/${job.leadId}`);
      await expect(page.getByRole("heading", { name: seed.name })).toBeVisible();
      await openDialog(page, page.getByRole("button", { name: "25% invoice" }));
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(seed.invoiceNumber);
      await expect(sendAgain(dialog)).toBeVisible();
      await expect(dialog.getByRole("alert")).toHaveCount(0);
    });

    await step("the customer pays — the open dialog knows nothing about it", page, async () => {
      pending = { job, rail: "commitment" };
      await landPayment(job, "commitment");
      await expect(sendAgain(dialog)).toBeVisible();
    });

    await step("Send is refused server-side and the dialog corrects itself", page, async () => {
      await sendAgain(dialog).click();
      await expect(toastSaying(page, REFUSAL.commitment)).toBeVisible({ timeout: 30_000 });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("alert")).toHaveText(REFUSAL.commitment, { timeout: 20_000 });
      await expect(dialog).toContainText(seed.invoiceNumber);
      await expect(sendAgain(dialog)).toHaveCount(0);
    });
  });

  test("balance — the balance lands while the dialog is open", async ({ page }) => {
    const seed = SEED.resendRaceBalance;
    const job = await jobByQuoteRef(seed.quoteRef);
    // The final-invoice dialog names the invoice rather than the quote — scope to
    // it, since it is this job's alone.
    const dialog = page.getByRole("dialog").filter({ hasText: seed.invoiceNumber });

    await step("the final invoice is raised, unpaid, and may be sent again", page, async () => {
      await page.goto(`/leads/${job.leadId}`);
      await expect(page.getByRole("heading", { name: seed.name })).toBeVisible();
      await openDialog(page, page.getByRole("button", { name: "Final invoice" }));
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("awaiting payment");
      await expect(sendAgain(dialog)).toBeVisible();
    });

    await step("the customer pays — the open dialog knows nothing about it", page, async () => {
      pending = { job, rail: "balance" };
      await landPayment(job, "balance");
      await expect(sendAgain(dialog)).toBeVisible();
    });

    await step("Send is refused server-side and the dialog corrects itself", page, async () => {
      await sendAgain(dialog).click();
      await expect(toastSaying(page, REFUSAL.balance)).toBeVisible({ timeout: 30_000 });
      await expect(dialog).toBeVisible();
      // This rail states the outcome rather than repeating the refusal: the same
      // invoice, now PAID, with nothing left to send.
      await expect(dialog).toContainText("· PAID", { timeout: 20_000 });
      await expect(dialog).toContainText("Nothing further to send.");
      await expect(sendAgain(dialog)).toHaveCount(0);
    });
  });
});
