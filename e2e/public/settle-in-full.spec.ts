import { test, expect } from "@playwright/test";
import { step } from "../fixtures/artefacts";
import { stagingInvoicesByRefPrefix } from "../fixtures/zoho";
import { SEED } from "../fixtures/seed-data";

/**
 * Gate 9c (PRD §3.10 Addition 3) — "settle in full" at the commitment step.
 *
 * The whole safety property of this feature is that **ignoring the option
 * changes nothing**, so the first test is the one that proves the page still
 * asks for the 25% by default and the second is the one that proves choosing
 * the other card actually raises the T-7 balance early.
 *
 * The raise talks to the STAGING Zoho org, so that leg is gated on a numeric
 * ZOHO_ORG_ID exactly as the accept legs are. The default-state assertions need
 * no ledger at all and always run.
 */

// True only when ZOHO_ORG_ID is a real numeric org id (staging), not the E2E dummy.
const ZOHO_STAGING = /^\d+$/.test(process.env.ZOHO_ORG_ID ?? "");

const { commitmentDue: C } = SEED;
const gbp = (n: number) => "£" + n.toLocaleString("en-GB");

test.describe("Customer — settle in full at the commitment step (/q)", () => {
  test("the page offers both figures, and asks for the 25% by default", async ({ page }) => {
    await step("open the booking page at the commitment step", page, async () => {
      await page.goto(`/q/${C.acceptToken}`);
      await expect(page.getByText("Move date confirmed")).toBeVisible();
    });

    await step("two amount cards: the agreed 25% first, the whole lot second", page, async () => {
      const commitment = page.getByRole("radio", { name: /Pay 25% now/i });
      const full = page.getByRole("radio", { name: /Settle in full/i });
      await expect(commitment).toBeVisible();
      await expect(full).toBeVisible();
      // The ladder the customer agreed is what is selected. The other card is an
      // offer, never a nudge — and a page that pre-selected it would be asking
      // for £1,900 from someone who agreed to pay £400.
      await expect(commitment).toBeChecked();
      await expect(full).not.toBeChecked();
      await expect(page.getByText(gbp(C.commitment), { exact: true }).first()).toBeVisible();
      await expect(page.getByText(gbp(C.full), { exact: true }).first()).toBeVisible();
    });

    await step("the bank block follows the default selection", page, async () => {
      const bank = page.getByText("Pay by bank transfer").locator("..");
      await expect(bank.getByText(gbp(C.commitment), { exact: true })).toBeVisible();
      // The reference is the quote ref whichever amount is chosen — one
      // reference, two invoices, settled together by the office's whole-quote
      // link (#73) when a single transfer covers both.
      await expect(bank.getByText(C.quoteRef, { exact: true })).toBeVisible();
    });
  });

  test("choosing 'settle in full' raises the balance early (needs the Zoho staging org)", async ({
    page,
  }) => {
    test.skip(!ZOHO_STAGING, "Set ZOHO_ORG_ID to the staging Zoho Invoice org id to run the raise.");

    await step("no balance invoice exists before the customer chooses", page, async () => {
      // Proving the starting state matters here: without it, a -BAL left over
      // from a previous run would make the assertion below pass on its own.
      const before = await stagingInvoicesByRefPrefix(C.quoteRef);
      expect(
        before.find((i) => i.ref.endsWith("-BAL")),
        "the seeded booking starts with no balance invoice",
      ).toBeFalsy();
    });

    await step("select 'settle in full' — the amount follows, the reference does not", page, async () => {
      await page.goto(`/q/${C.acceptToken}`);
      await page.getByRole("radio", { name: /Settle in full/i }).check();
      // The bank block's Amount follows the selection while the reference does
      // not. This is the anatomy of the mock in one assertion — but it is a
      // CLIENT-side assertion and proves nothing about the server: the amount
      // is shown optimistically, before the raise comes back. Waiting on it and
      // then reading the books is a race, and it is the race this spec lost on
      // its first run (the page snapshot still said "Preparing your final
      // invoice…"). The server proof is the next step.
      const bank = page.getByText("Pay by bank transfer").locator("..");
      await expect(bank.getByText(gbp(C.full), { exact: true })).toBeVisible();
      await expect(bank.getByText(C.quoteRef, { exact: true })).toBeVisible();
    });

    await step("the choice lands: the page re-renders without it", page, async () => {
      // The completion signal that means something. Once the balance is raised,
      // `payInFullAvailable` is false — there is nothing left to offer — so the
      // server re-render drops the radios entirely and shows the final-balance
      // card instead. That transition can only happen if the action actually
      // succeeded, which the optimistic amount above cannot tell us.
      await expect(page.getByRole("radio", { name: /Settle in full/i })).toHaveCount(0, {
        timeout: 60_000,
      });
      await expect(page.getByText(/Final balance/i).first()).toBeVisible();
      await expect(page.getByText(gbp(C.balanceRemaining), { exact: true }).first()).toBeVisible();
    });

    await step("the real books: a -BAL for the remainder, raised early", page, async () => {
      const invoices = await stagingInvoicesByRefPrefix(C.quoteRef);
      const bal = invoices.find((i) => i.ref.endsWith("-BAL"));
      expect(bal, "choosing to settle in full raised the balance invoice").toBeTruthy();
      // The remainder AFTER the deposit and the commitment — the invoices
      // partition the agreed price, they never overlap.
      expect(bal!.total).toBeCloseTo(C.balanceRemaining, 2);
      expect(bal!.taxTotal).toBeGreaterThan(0);
      expect(bal!.subTotal + bal!.taxTotal).toBeCloseTo(bal!.total, 1);
      // And the sum the customer was shown is the sum of what they now owe.
      expect(C.commitment + bal!.total).toBeCloseTo(C.full, 2);
    });

    await step("re-opening the page is idempotent — no second invoice", page, async () => {
      await page.reload();
      const invoices = await stagingInvoicesByRefPrefix(C.quoteRef);
      expect(invoices.filter((i) => i.ref.endsWith("-BAL")).length).toBe(1);
    });
  });
});
