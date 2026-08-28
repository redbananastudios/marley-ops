import { test, expect } from "@playwright/test";
import { step } from "../fixtures/artefacts";
import { submitUntil } from "../fixtures/ui";
import { stagingInvoicesByRefPrefix } from "../fixtures/zoho";
import { SEED } from "../fixtures/seed-data";

/**
 * Customer journey (PRD B2): the public accept page /q/<token>. No auth (the
 * "public" project).
 *
 * The quote VIEW is testable now. The accept → deposit-invoice leg raises a real
 * invoice in Zoho, so it's gated on a STAGING Zoho org id (ZOHO_ORG_ID numeric —
 * never Connor's live org). The card-deposit leg additionally needs the
 * takepayments sandbox and lives in P0 #6.
 */

// True only when ZOHO_ORG_ID is a real numeric org id (staging), not the E2E dummy.
const ZOHO_STAGING = /^\d+$/.test(process.env.ZOHO_ORG_ID ?? "");

test.describe("Customer — accept page (/q)", () => {
  test("the sent quote renders on the public link", async ({ page }) => {
    await step("open the customer quote link", page, async () => {
      await page.goto(`/q/${SEED.sentQuote.acceptToken}`);
      await expect(page.getByText("Your removal quote")).toBeVisible();
      await expect(page.getByText(SEED.sentQuote.quoteRef)).toBeVisible();
      // gbp() strips .00 → £1,500.
      await expect(page.getByText("£1,500")).toBeVisible();
    });

    await step("the accept form + deposit terms are shown", page, async () => {
      await expect(page.getByText(/deposit secures the booking/i)).toBeVisible();
      await expect(page.getByLabel("Your full name")).toBeVisible();
      await expect(page.getByRole("button", { name: /Accept quote & pay/i })).toBeVisible();
    });
  });

  test("accept online → deposit invoice raised (needs the Zoho staging org)", async ({ page }) => {
    test.skip(!ZOHO_STAGING, "Set ZOHO_ORG_ID to the staging Zoho Invoice org id to run the accept→deposit-invoice leg.");

    await step("tick the acknowledgments, sign by name, accept", page, async () => {
      await page.goto(`/q/${SEED.sentQuote.acceptToken}`);
      await page.waitForLoadState("networkidle");
      // submitUntil survives the pre-hydration native form submit: it re-ticks +
      // re-fills on the reload, so the hydrated attempt runs acceptQuoteAction
      // (which raises the £100 deposit invoice in the STAGING Zoho org).
      await submitUntil(page, {
        prepare: async () => {
          const boxes = page.getByRole("checkbox");
          const n = await boxes.count();
          for (let i = 0; i < n; i++) await boxes.nth(i).check();
          await page.getByLabel("Your full name").fill("E2E Sent Quote");
        },
        click: page.getByRole("button", { name: /Accept quote & pay/i }),
        expected: page.getByText(/deposit to secure your date/i),
      });
    });

    await step("lands on the pay screen — the deposit invoice was raised in staging", page, async () => {
      // The accepted → pay view: deposit heading + BACS panel with the quote ref.
      await expect(page.getByText(/deposit to secure your date/i)).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(/Pay by bank transfer/i)).toBeVisible();
      // The BACS reference IS the quote ref (renders twice on the pay screen).
      await expect(page.getByText(SEED.sentQuote.quoteRef).first()).toBeVisible();
    });

    await step("the real books: a VAT-itemised £100 deposit invoice, in STAGING only", page, async () => {
      // Assert against the staging Zoho org itself — the strongest proof the money
      // landed correctly AND in Demo Removals, never Connor's live books.
      const invoices = await stagingInvoicesByRefPrefix(SEED.sentQuote.quoteRef);
      const dep = invoices.find((i) => i.ref.endsWith("-DEP"));
      expect(dep, "a -DEP deposit invoice exists in staging for the accepted quote").toBeTruthy();
      // £100 VAT-inclusive deposit → its own invoice, itemised ex-VAT + 20% VAT
      // (never a single net line): total £100, VAT ≈ £16.67, net ≈ £83.33.
      expect(dep!.total).toBeCloseTo(100, 2);
      expect(dep!.taxTotal).toBeGreaterThan(0);
      expect(dep!.subTotal + dep!.taxTotal).toBeCloseTo(dep!.total, 1);
      // Gate 9b parity, asserted at the ledger rather than in a unit test: this
      // move is 21 days out, so acceptance raises the deposit and NOTHING else.
      // The balance still belongs to the T-7 cron. A -BAL here would mean the
      // late-booking rule had escaped its window onto every booking in the system.
      expect(
        invoices.find((i) => i.ref.endsWith("-BAL")),
        "an ordinary booking raises NO balance invoice at acceptance",
      ).toBeFalsy();
    });
  });
});

/**
 * Gate 9b (PRD §3.10 Addition 2) — a move inside T-7 meets its whole bill at
 * acceptance, instead of being asked for 25% today and the rest in an email days
 * later, sometimes after the move has already happened.
 *
 * This runs against the STAGING Zoho org and raises TWO real invoices, which is
 * the point of it: the rule itself is pure and unit-tested, and no unit test can
 * show that two documents actually exist in the books and partition the price
 * exactly. The strongest single assertion here is the sum — a bug that failed to
 * carve the deposit out would invoice the customer 125% of their move, and it
 * would look perfectly reasonable on either invoice read on its own.
 */
test.describe("Customer — a late booking is invoiced in full at acceptance", () => {
  test.skip(!ZOHO_STAGING, "Set ZOHO_ORG_ID to the staging Zoho Invoice org id to run the late-booking leg.");

  test("accept a move 3 days out → collapsed ask AND balance, both raised", async ({ page }) => {
    const { lateQuote } = SEED;
    const startedAt = Date.now();

    await step("the pre-accept page asks for the collapsed 25%, not the base deposit", page, async () => {
      await page.goto(`/q/${lateQuote.acceptToken}`);
      await expect(page.getByText("Your removal quote")).toBeVisible();
      // requestedDeposit rule 2 is computed live before acceptance, so £500 has
      // to be on the page the customer actually reads — never the seeded £100
      // base (/qa 2026-08-05: a £300 ask whose payment email said £100).
      //
      // Both places it appears are asserted, and both exactly: the terms line
      // and the button carry the SAME figure, which is the actual property worth
      // holding. A loose /£500 deposit/ matches both and fails strict mode.
      await expect(page.getByText("£500 deposit", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: /Accept quote & pay £500 deposit/ })).toBeVisible();
      // Nothing anywhere still offers the pre-collapse base.
      await expect(page.getByText(/£100 deposit/)).toHaveCount(0);
    });

    await step("tick the acknowledgments, sign by name, accept", page, async () => {
      await page.waitForLoadState("networkidle");
      await submitUntil(page, {
        prepare: async () => {
          const boxes = page.getByRole("checkbox");
          const n = await boxes.count();
          for (let i = 0; i < n; i++) await boxes.nth(i).check();
          await page.getByLabel("Your full name").fill(lateQuote.name);
        },
        click: page.getByRole("button", { name: /Accept quote & pay/i }),
        expected: page.getByText(/deposit to secure your date/i),
      });
    });

    await step("the pay screen names BOTH invoices and their total", page, async () => {
      // The deposit state was the only screen in the ladder that could not see a
      // raised balance. A customer told £500 while a £1,500 invoice sits unseen
      // in their inbox is the Greig James shape (MMR015) on a new surface.
      await expect(page.getByText(/£500/).first()).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(/£1,500/).first()).toBeVisible();
      await expect(page.getByText(/£2,000/).first()).toBeVisible();
      await expect(page.getByText(/Pay by bank transfer/i)).toBeVisible();
    });

    await step("the real books: -DEP and -BAL both exist and sum to the agreed price", page, async () => {
      const invoices = await stagingInvoicesByRefPrefix(lateQuote.quoteRef);
      const dep = invoices.find((i) => i.ref.endsWith("-DEP"));
      const bal = invoices.find((i) => i.ref.endsWith("-BAL"));
      expect(dep, "a -DEP invoice exists for the late booking").toBeTruthy();
      expect(bal, "a -BAL invoice was raised at acceptance, not left to the T-7 cron").toBeTruthy();
      expect(dep!.total).toBeCloseTo(lateQuote.collapsedDeposit, 2);
      expect(bal!.total).toBeCloseTo(lateQuote.balance, 2);
      // THE invariant: the invoices partition the agreed price. They never
      // overlap and never leave a gap.
      expect(dep!.total + bal!.total).toBeCloseTo(lateQuote.total, 2);
      // Each is a VAT document in its own right, never one net line.
      for (const inv of [dep!, bal!]) {
        expect(inv.taxTotal).toBeGreaterThan(0);
        expect(inv.subTotal + inv.taxTotal).toBeCloseTo(inv.total, 1);
      }
      // And no commitment invoice: the collapsed ask already IS the 25%, so
      // commitmentAmount clamps to zero and a third document must never appear.
      expect(
        invoices.find((i) => i.ref.endsWith("-COM")),
        "a collapsed late booking raises no commitment invoice",
      ).toBeFalsy();
    });

    // Acceptance now blocks on a SECOND ledger create plus a PDF fetch, and the
    // customer waits for that on the accept button. Reported rather than
    // asserted: a loaded runner is a legitimate reason to be slow, and a flaky
    // gate here would block every later gate. A number climbing run-on-run is
    // the signal worth acting on.
    const took = Math.round((Date.now() - startedAt) / 100) / 10;
    console.log(`[late-booking] accept → both invoices verified in ${took}s`);
  });
});
