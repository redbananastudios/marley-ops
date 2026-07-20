import { test, type Page, type Download } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Artefact capture (PRD B2: "Full-page screenshot at every step. Capture email
 * HTML and generated PDFs to /artefacts"). Everything lands under
 * e2e/artefacts/<sanitised-test-title>/ — gitignored, and fed to the LLM
 * artefact reviewer (e2e/artefacts/review.mjs) after a run.
 */

const ROOT = "e2e/artefacts";

const slug = (s: string) => s.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);

function dirFor(): string {
  const dir = join(ROOT, slug(test.info().title || "test"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

let counter = 0;
let counterKey = "";

/** Run a named step and capture a full-page screenshot at the end of it.
 *  The sequence number resets per test so each artefact folder reads 01, 02, … */
export async function step(name: string, page: Page, body: () => Promise<void>): Promise<void> {
  const key = test.info().testId;
  if (key !== counterKey) {
    counter = 0;
    counterKey = key;
  }
  await test.step(name, async () => {
    await body();
    const file = join(dirFor(), `${String(++counter).padStart(2, "0")}-${slug(name)}.png`);
    await page.screenshot({ path: file, fullPage: true });
    await test.info().attach(name, { path: file, contentType: "image/png" });
  });
}

/** Save a generated PDF the page offered as a download. */
export async function captureDownload(download: Download, name: string): Promise<string> {
  const file = join(dirFor(), `${slug(name)}-${slug(download.suggestedFilename())}`);
  await download.saveAs(file);
  await test.info().attach(name, { path: file });
  return file;
}

/** Persist captured email/HTML/text (from a mail sink or an in-app preview). */
export function saveArtefact(name: string, content: string, ext = "html"): string {
  const file = join(dirFor(), `${slug(name)}.${ext}`);
  writeFileSync(file, content);
  return file;
}
