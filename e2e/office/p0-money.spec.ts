import { test, expect } from "@playwright/test";
import { step } from "../fixtures/artefacts";
import { stagingInvoicesByRefPrefix } from "../fixtures/zoho";
import { SEED } from "../fixtures/seed-data";

/**
 * P0 money scenarios (PRD B3) — office role, against the STAGING Zoho org.
 *
 * #1 (deposit + balance invoiced SEPARATELY, each VAT-itemised) runs in full:
 * its balance leg here, its deposit leg proven by the customer accept journey
 * (customer.spec.ts asserts the -DEP invoice in staging). Together they prove the
 * invariant — two invoices per job under distinct references, each VAT-itemised,
 * the deposit carved out of the balance — never one net invoice.
 *
 * #2–#6 stay `fixme` with the ACCURATE reason each is not an automated E2E:
 * refunds/credit notes are deliberately manual in Zoho (no app flow to drive),
 * the VAT-quarter maths is unit-covered and needs backdated tax points, and the
 * declined-card path needs the takepayments sandbox. They must not ship as false
 * green. See e2e/README.md.
 */

// True only when ZOHO_ORG_ID is a real numeric org id (staging), not the E2E dummy.
const ZOHO_STAGING = /^\d+$/.test(process.env.ZOHO_ORG_ID ?? "");

test.describe("P0 #1 — deposit + balance invoiced separately", () => {
  test.skip(!ZOHO_STAGING, "Set ZOHO_ORG_ID to the staging Zoho org id (see e2e/README.md).");

  test("the balance is its own VAT-itemised invoice, excluding the deposit", async ({ page }) => {
    await step("open the completed job via search", page, async () => {
      await page.goto("/");
      await page.waitForLoadState("networkidle");
      // The Ctrl-K listener attaches after hydration — retry until it opens.
      const search = page.getByRole("combobox", { name: /Search leads/i });
      await expect(async () => {
        await page.keyboard.press("Control+K");
        await expect(search).toBeVisible({ timeout: 1500 });
      }).toPass({ timeout: 15_000 });
      await search.fill(SEED.balanceDue.name);
      // Leads sort before clients in the results, so the first match is the lead.
      await page.getByRole("option").filter({ hasText: SEED.balanceDue.name }).first().click();
      await expect(page).toHaveURL(/\/leads\//);
      await expect(page.getByRole("heading", { name: SEED.balanceDue.name })).toBeVisible();
    });

    await step("raise the final (balance) invoice", page, async () => {
      // £2,400 agreed − £100 deposit = £2,300 balance (the deposit is a SEPARATE
      // invoice, so the balance is not the full agreed price).
      const openBtn = page.getByRole("button", { name: /Final invoice/i });
      await expect(async () => {
        await openBtn.click();
        await expect(page.getByRole("dialog")).toBeVisible({ timeout: 1500 });
      }).toPass({ timeout: 15_000 });
      const dialog = page.getByRole("dialog");
      // The confirm button carries the exact figure — asserts £2,300 AND clicks it.
      const confirm = dialog.getByRole("button", { name: /Create .*£2,300.*invoice/i });
      await expect(confirm).toBeVisible();
      await confirm.click();
      // The dialog closes only on success (an error keeps it open with the reason).
      await expect(dialog).toBeHidden({ timeout: 30_000 });
    });

    await step("the real books: a VAT-itemised -BAL invoice at £2,300, in STAGING", page, async () => {
      const invoices = await stagingInvoicesByRefPrefix(SEED.balanceDue.quoteRef);
      const bal = invoices.find((i) => i.ref.endsWith("-BAL"));
      expect(bal, "a -BAL balance invoice exists in staging").toBeTruthy();
      // £2,300 (deposit excluded), itemised ex-VAT + 20% VAT — never one net line.
      expect(bal!.total).toBeCloseTo(2300, 2);
      expect(bal!.taxTotal).toBeGreaterThan(0);
      expect(bal!.subTotal + bal!.taxTotal).toBeCloseTo(bal!.total, 1);
    });
  });
});

test.describe("P0 money scenarios — manual / sandbox-gated", () => {
  test("#2 refund in full after cancel → credit note, VAT reverses", async () => {
    test.fixme(true, "NOT an app flow: refunds + credit notes are handled manually in Zoho by design (deferred 2026-07-09). Marley-ops raises a refund-DECISION task on cancel; the credit note itself is a human Zoho action, so there is nothing to drive in-app. The card-deposit refund path exists but needs the takepayments sandbox (see #6).");
  });
  test("#3 forfeit after cancel → deposit invoice + VAT retained", async () => {
    test.fixme(true, "NOT an app flow: forfeiting is a human decision. On cancel the app cancels future appointments, voids UNPAID invoices, and raises a refund-decision task when money was taken — it never auto-forfeits or auto-refunds a PAID deposit (that -DEP invoice + its VAT simply stay). The unwind is unit-tested; the forfeit/keep call is manual in Zoho.");
  });
  test("#4 priced lower on the day → partial credit note", async () => {
    test.fixme(true, "NOT an app flow: partial credit notes are manual in Zoho (same deferral as #2). The supersede path re-quotes at the new price and carries a paid deposit forward, but issuing a credit for an over-invoiced amount is a human Zoho action.");
  });
  test("#5 deposit in one VAT quarter, move in the next → VAT lands per tax point", async () => {
    test.fixme(true, "Covered by unit tests, not drivable as E2E: the VAT-quarter attribution maths lives in lib/finance and is unit-tested (staggers, year-wrap, leap-Feb). An E2E can't set differing tax-point dates because Zoho invoices are dated at creation and the UI has no backdating.");
  });
  test("#6 card declined mid-booking → job not confirmed, no orphaned records", async () => {
    test.fixme(true, "Needs the takepayments SANDBOX (declined PAN) — deferred until the merchant id + sandbox land. Assert: a declined authorisation leaves the quote un-accepted, no deposit recorded, no Zoho invoice, no confirmed booking.");
  });
});
