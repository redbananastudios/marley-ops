import { expect, type Page, type Locator } from "@playwright/test";

/**
 * Click a submit control and wait for the page to advance to `expected`.
 *
 * Guards the Next.js pre-hydration race: a `<form onSubmit>` button clicked
 * before React attaches its handler does a NATIVE form submission (a plain GET
 * reload) instead of running the server action — the checkboxes/fields are wiped
 * and nothing happens. On a miss this re-runs `prepare` (re-tick, re-fill) and
 * clicks again, so the second attempt (now hydrated) runs the real action.
 *
 * `perAttemptMs` is the success window per attempt, and it must cover the WHOLE
 * hydrated path: server action + `router.push` + the destination page's first
 * paint. Against staging the app (OVH box) and DB (Supabase Cloud, eu-west-1)
 * are in different regions, so a create-then-navigate round-trips the internet
 * and routinely takes >8s — the old default. Too short a window is actively
 * harmful here: the action ALREADY succeeded, so a premature retry re-submits
 * and creates a DUPLICATE record (three E2E leads, 8s apart, were the tell).
 * 30s comfortably clears the cross-region navigation while staying well inside
 * the 90s test budget, so a hydrated submit wins on the first attempt and never
 * duplicates; the retry path stays only for a genuine pre-hydration miss.
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
      await opts.expected.waitFor({ state: "visible", timeout: opts.perAttemptMs ?? 30_000 });
      return;
    } catch {
      if (i === attempts) break;
      await page.waitForLoadState("networkidle").catch(() => {});
    }
  }
  await expect(opts.expected).toBeVisible({ timeout: 5000 });
}

/** Text the app's error boundaries render — a page that shows this 500'd. */
const ERROR_BOUNDARY = /Something went wrong|Application error|Unhandled Runtime|Internal Server Error|This page can'?t load/i;

/**
 * A page loaded for THIS role: it wasn't bounced to /login, the app shell
 * rendered a <main>, and no error boundary fired. Deliberately selector-light so
 * it works across every route without per-page headings.
 */
export async function expectPageLoaded(page: Page, path: string): Promise<void> {
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await expect(page, `${path} should not bounce to /login`).not.toHaveURL(/\/login/);
  await expect(page.locator("main").first(), `${path} should render a <main>`).toBeVisible();
  await expect(page.getByText(ERROR_BOUNDARY), `${path} should not hit the error boundary`).toHaveCount(0);
}

/** A role that must NOT see `path` is redirected somewhere matching `to`. */
export async function expectBounced(page: Page, path: string, to: RegExp): Promise<void> {
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await expect(page, `${path} should redirect this role`).toHaveURL(to);
}

/**
 * Click a trigger and wait for the dialog to open, retrying through the
 * pre-hydration window where the onClick handler isn't attached yet (the click
 * is a no-op until React hydrates). Returns the dialog locator.
 */
export async function openDialog(page: Page, trigger: Locator): Promise<Locator> {
  const dialog = page.getByRole("dialog");
  await expect(async () => {
    await trigger.click();
    await expect(dialog).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 15_000 });
  return dialog;
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
