import { expect, type Page, type Locator } from "@playwright/test";

/**
 * Click a submit control and wait for the page to advance to `expected`.
 *
 * Guards the Next.js pre-hydration race: a `<form onSubmit>` button clicked
 * before React attaches its handler does a NATIVE form submission (a plain GET
 * reload) instead of running the server action — the checkboxes/fields are wiped
 * and nothing happens. On a miss this re-runs `prepare` (re-tick, re-fill) and
 * clicks again, so the second attempt (now hydrated) runs the real action.
 */
export async function submitUntil(
  page: Page,
  opts: {
    prepare?: () => Promise<void>;
    click: Locator;
    expected: Locator;
    attempts?: number;
    perAttemptMs?: number;
  },
): Promise<void> {
  const attempts = opts.attempts ?? 3;
  for (let i = 1; i <= attempts; i++) {
    if (opts.prepare) await opts.prepare();
    await opts.click.click();
    try {
      await opts.expected.waitFor({ state: "visible", timeout: opts.perAttemptMs ?? 8000 });
      return;
    } catch {
      if (i === attempts) break;
      await page.waitForLoadState("networkidle").catch(() => {});
    }
  }
  await expect(opts.expected).toBeVisible({ timeout: 5000 });
}

/**
 * Draw a few strokes on a <canvas> signature pad so it yields a real (non-blank)
 * signature data-URI — the server rejects an empty one. Works by dragging the
 * mouse across the canvas bounding box.
 */
export async function drawSignature(page: Page, canvas: Locator): Promise<void> {
  // Bring the canvas fully into view first — in a tall scrollable dialog a
  // below-the-fold pad yields off-screen coordinates, so the strokes would land
  // on the backdrop (closing the dialog) instead of the pad.
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("signature canvas not visible");
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.15, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.4, y - box.height * 0.25, { steps: 8 });
  await page.mouse.move(box.x + box.width * 0.65, y + box.height * 0.25, { steps: 8 });
  await page.mouse.move(box.x + box.width * 0.85, y, { steps: 8 });
  await page.mouse.up();
}
