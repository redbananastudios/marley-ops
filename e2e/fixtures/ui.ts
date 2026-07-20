import type { Page, Locator } from "@playwright/test";

/**
 * Draw a few strokes on a <canvas> signature pad so it yields a real (non-blank)
 * signature data-URI — the server rejects an empty one. Works by dragging the
 * mouse across the canvas bounding box.
 */
export async function drawSignature(page: Page, canvas: Locator): Promise<void> {
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
