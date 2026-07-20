import { test, expect } from "@playwright/test";
import { step } from "../fixtures/artefacts";
import { drawSignature } from "../fixtures/ui";
import { SEED } from "../fixtures/seed-data";

/**
 * P0 scenarios — must all pass before go-live (PRD B3). The crew-reliability
 * pair (#7 offline completion, #8 double-submit) are the ones this branch
 * directly implements, so they're written in full here. The money scenarios
 * (#1–#6) need the Zoho + takepayments SANDBOXES wired to staging; they're
 * captured as fixme specs with the exact rule each must prove, ready to fill in
 * against staging. See e2e/README.md.
 */

// ── #7 — Crew completes a job offline; it queues and syncs on reconnect ───────
test.describe("P0 #7 — offline job completion is never lost", () => {
  test("completing offline queues locally, then syncs when signal returns", async ({ page, context }) => {
    await step("open the seeded crew job", page, async () => {
      await page.goto("/my-jobs");
      await page.getByText(SEED.crewJobCustomer.name).first().click();
      await expect(page.getByRole("heading", { name: SEED.crewJobCustomer.name })).toBeVisible();
    });

    await step("go offline", page, async () => {
      await context.setOffline(true);
      await expect(page.getByText(/You're offline/)).toBeVisible(); // A2/A3 status bar
    });

    await step("fill + sign the completion", page, async () => {
      await page.getByRole("button", { name: "Complete job" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await dialog.getByLabel(/Exceptions/i).fill("E2E: nothing to report");
      // customer name defaults from the job; ensure it's set
      const nameInput = dialog.getByLabel(/customer'?s? name/i);
      if (await nameInput.count()) await nameInput.fill(SEED.crewJobCustomer.name);
      const canvases = dialog.locator("canvas");
      await drawSignature(page, canvases.nth(0));
      await drawSignature(page, canvases.nth(1));
    });

    await step("submit while offline → saved to the outbox, not lost", page, async () => {
      await page.getByRole("dialog").getByRole("button", { name: "Complete job" }).click();
      await expect(page.getByText(/Saved on your phone/i)).toBeVisible();
      // The action button becomes the pending-sync badge (can't be re-signed).
      await expect(page.getByText(/waiting to sync/i)).toBeVisible();
    });

    await step("reconnect → it syncs automatically", page, async () => {
      await context.setOffline(false);
      // The outbox flushes on the online event; the job ends up completed.
      await expect(page.getByText(/waiting to sync/i)).toBeHidden({ timeout: 30_000 });
      await expect(page.getByText(/couldn'?t sync/i)).toBeHidden();
    });
  });
});

// ── #8 — Double submission produces exactly one record ────────────────────────
test.describe("P0 #8 — double-submit is idempotent", () => {
  test("double-tapping complete yields one completion, not two", async ({ page }) => {
    await step("open a fresh seeded crew job online", page, async () => {
      await page.goto("/my-jobs");
      await page.getByText(SEED.crewJobCustomer.name).first().click();
      await expect(page.getByRole("heading", { name: SEED.crewJobCustomer.name })).toBeVisible();
    });

    await step("fill + sign", page, async () => {
      await page.getByRole("button", { name: "Complete job" }).click();
      const dialog = page.getByRole("dialog");
      const canvases = dialog.locator("canvas");
      await drawSignature(page, canvases.nth(0));
      await drawSignature(page, canvases.nth(1));
    });

    await step("double-tap submit → collapses to ONE completion", page, async () => {
      const submit = page.getByRole("dialog").getByRole("button", { name: "Complete job" });
      // Genuinely fire a second tap. The client guard disables the button during
      // the transition, so the second click is forced (bypasses actionability) —
      // whether it's swallowed client-side OR reaches the server, appointment_id
      // uniqueness must collapse both to one record + one email.
      await submit.click();
      await submit.click({ force: true, timeout: 2000 }).catch(() => {}); // second tap: disabled = the guard working
      await expect(page.getByText(/completed|already signed off/i)).toBeVisible();
      // Exactly once: the job is now terminal — no second Complete affordance.
      await page.reload();
      await expect(page.getByRole("button", { name: "Complete job" })).toHaveCount(0);
    });
  });
});

// ── #1–#6 — money scenarios (need Zoho + takepayments sandbox on staging) ─────
test.describe("P0 money scenarios (fill against staging with sandboxes wired)", () => {
  test("#1 deposit + balance are invoiced SEPARATELY, never one net invoice", async () => {
    test.fixme(true, "Needs Zoho sandbox. Assert: after deposit paid + move completed, /finance shows two invoices for the job ref — a -DEP and a -BAL — each with its own VAT line; never a single invoice with a deduction.");
  });
  test("#2 cancel after deposit, refunded in full → credit note, VAT reverses", async () => {
    test.fixme(true, "Assert: refunding the deposit raises a Zoho credit note against the -DEP invoice and the reversed VAT drops out of the period's output VAT on /finance.");
  });
  test("#3 cancel after deposit, forfeited → VAT stays due, net → cancellation fees", async () => {
    test.fixme(true, "Assert: forfeiting keeps the -DEP invoice + its VAT; the net is recognised as a cancellation fee, not refunded.");
  });
  test("#4 priced lower on the day → partial credit note, correct VAT", async () => {
    test.fixme(true, "Assert: reducing the agreed price on completion raises a partial credit note; VAT on the credit matches the reduction at the inclusive rate.");
  });
  test("#5 deposit in one VAT quarter, move in the next → VAT lands in the deposit's quarter", async () => {
    test.fixme(true, "Assert: with the deposit tax-point in Q1 and the move in Q2, /finance attributes the deposit VAT to Q1 and the balance VAT to Q2.");
  });
  test("#6 card declined mid-booking → job not confirmed, no orphaned records", async () => {
    test.fixme(true, "Needs takepayments sandbox declined card. Assert: a declined authorisation leaves the quote un-accepted, no deposit recorded, no Zoho invoice, no confirmed booking.");
  });
});
