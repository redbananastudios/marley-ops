import { test, expect } from "@playwright/test";
import { step } from "../fixtures/artefacts";
import { submitUntil } from "../fixtures/ui";
import { SEED } from "../fixtures/seed-data";

/**
 * Crew job detail — the phone job sheet: route, inventory, and the private crew
 * notes (an internal record, never customer-facing). Adds a note end-to-end.
 * (Sign-off + offline behaviour are covered by crew/p0.spec.)
 */
test.describe("Crew — job detail + notes", () => {
  test("open a job, read the brief, add a crew note", async ({ page }) => {
    await step("open the seeded crew job", page, async () => {
      await page.goto("/my-jobs");
      await page.getByText(SEED.crewJobCustomer.name).first().click();
      await expect(page.getByRole("heading", { name: SEED.crewJobCustomer.name })).toBeVisible();
      // The job brief: the two route cards.
      await expect(page.getByText(/Moving from/i)).toBeVisible();
      await expect(page.getByText(/Moving to/i)).toBeVisible();
    });

    await step("add a private crew note", page, async () => {
      await page.waitForLoadState("networkidle");
      const note = `E2E crew note ${Date.now()}`;
      // submitUntil re-fills + re-clicks through the pre-hydration window (the
      // Save button's onClick is a no-op until React attaches it).
      await submitUntil(page, {
        prepare: async () => {
          const box = page.getByPlaceholder(/Add a note — damage/i);
          await box.scrollIntoViewIfNeeded();
          await box.fill(note);
        },
        click: page.getByRole("button", { name: /Save note/i }),
        expected: page.getByText(note),
      });
    });
  });

  // A 1x1 red pixel PNG — small enough to keep the upload instant, real enough
  // to carry genuine PNG magic bytes through the TUS upload.
  const TINY_PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

  test("add a note with a photo, and the photo actually loads for another viewer", async ({ page, browser }) => {
    // Reuses crewJobCustomer (same job as the text-note test above) rather than
    // crewJobTwo/crewJobThree — both of those get COMPLETED by crew/p0.spec.ts,
    // which could run before this file and hide the note form on a finished job.
    await step("open the seeded crew job", page, async () => {
      await page.goto("/my-jobs");
      await page.getByText(SEED.crewJobCustomer.name).first().click();
      await expect(page.getByRole("heading", { name: SEED.crewJobCustomer.name })).toBeVisible();
    });

    const note = `E2E crew photo note ${Date.now()}`;

    await step("attach a photo and save the note", page, async () => {
      await page.waitForLoadState("networkidle");
      const fileInput = page.locator('input[type="file"][accept="image/*"]');
      await fileInput.setInputFiles({
        name: "receipt.png",
        mimeType: "image/png",
        buffer: Buffer.from(TINY_PNG_BASE64, "base64"),
      });
      // The upload target/PUT round-trip lands a local preview before Save is live.
      await expect(page.getByAltText("Photo to attach")).toBeVisible({ timeout: 15_000 });

      await submitUntil(page, {
        prepare: async () => {
          const box = page.getByPlaceholder(/Add a note — damage/i);
          await box.scrollIntoViewIfNeeded();
          await box.fill(note);
        },
        click: page.getByRole("button", { name: /Save note/i }),
        expected: page.getByText(note),
      });
    });

    await step("a fresh browser context — not just this page — actually loads the photo", page, async () => {
      // Same crew login (storageState), but a brand-new context/page: proves the
      // image is a real, independently loadable object, not a client-only blob URL
      // left over from the upload that happens to still resolve on this page.
      const freshContext = await browser.newContext({ storageState: page.context().storageState() as never });
      const freshPage = await freshContext.newPage();
      try {
        await freshPage.goto("/my-jobs");
        await freshPage.getByText(SEED.crewJobCustomer.name).first().click();
        await expect(freshPage.getByText(note)).toBeVisible();
        const img = freshPage.getByRole("img", { name: "Crew photo" }).first();
        await expect(img).toBeVisible();
        // The photo renders with loading="lazy" (components/crew/job-notes.tsx),
        // so a browser may not have STARTED fetching it while it sits below the
        // fold — and `toBeVisible()` only means it has a layout box, not that it
        // is in view or decoded. Scroll it in to trigger the fetch, then poll:
        // reading `complete` the instant it becomes visible catches the image
        // mid-load and reports a false negative.
        //
        // This waits, it does not weaken. If the photo genuinely never loads for
        // another viewer — the defect this test exists to catch — it still fails,
        // just after 15s instead of instantly.
        await img.scrollIntoViewIfNeeded();
        await expect
          .poll(
            () =>
              img.evaluate(
                (el: HTMLImageElement) => el.complete && el.naturalWidth > 0 && el.naturalHeight > 0,
              ),
            { timeout: 15_000, message: "the crew photo never finished loading in a fresh context" },
          )
          .toBe(true);
      } finally {
        await freshContext.close();
      }
    });
  });
});
