/**
 * Films the crew walkthrough footage against a LOCAL dev server + LOCAL
 * Supabase (guarded — refuses non-local URLs). One .webm per manual section
 * into crew/footage/, phone viewport (390x844 @2x), with a visible tap
 * indicator and ~1s pauses before every tap so Remotion zooms/captions land.
 *
 * Contract state is toggled per take: parts 2/3/5/6/7 film SIGNED (no banner),
 * part 4 films UNSIGNED so the yellow collect-signature banner shows.
 * Nothing is ever submitted: sign-off + contract dialogs are cancelled.
 *
 * Prereqs (run from training/):
 *   node --env-file=../.env.local crew/seed-demo.mjs
 *   node crew/tts.mjs                       (timeline.json sets take lengths)
 *   dev server running, e.g.  npx next dev -H 0.0.0.0 -p 3016  (in repo root)
 *
 * Run:  BASE_URL=http://localhost:3016 npx tsx crew/record.ts
 */
import { chromium, type BrowserContext, type Locator, type Page } from "playwright";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CREW_LOGIN, DEMO_CUSTOMER, DEMO_QUOTE_REF, localGuard } from "./demo.config.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const footageDir = path.join(here, "footage");
const tmpDir = path.join(footageDir, "tmp");

// ---- env (tsx has no --env-file; read ../.env.local ourselves) -------------
function loadEnv() {
  const p = path.join(here, "..", "..", ".env.local");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}
loadEnv();

const BASE_URL = process.env.BASE_URL || "http://localhost:3016";
const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
localGuard(SUPA_URL);
if (!/^http:\/\/(localhost|127\.0\.0\.1|i9)(:|\/)/.test(BASE_URL)) {
  throw new Error(`Refusing to film a non-local app URL: ${BASE_URL}`);
}

type Timeline = { id: string; durationSec: number }[];
const timeline: Timeline = JSON.parse(readFileSync(path.join(here, "audio", "timeline.json"), "utf8"));
const audioSec = (id: string) => timeline.find((t) => t.id === id)?.durationSec ?? 20;

// ---- demo rows --------------------------------------------------------------
const sb: SupabaseClient = createClient(SUPA_URL, SERVICE_KEY, { auth: { persistSession: false } });

async function demoIds() {
  const { data: quote } = await sb
    .from("quotes")
    .select("id, lead_id, client_id")
    .eq("quote_ref", DEMO_QUOTE_REF)
    .single();
  if (!quote) throw new Error(`Demo quote ${DEMO_QUOTE_REF} not found — run seed-demo.mjs first`);
  const { data: appt } = await sb
    .from("appointments")
    .select("id")
    .eq("lead_id", quote.lead_id!)
    .eq("appt_type", "removal")
    .single();
  if (!appt) throw new Error("Demo appointment not found — run seed-demo.mjs first");
  return { quoteId: quote.id, leadId: quote.lead_id!, clientId: quote.client_id, apptId: appt.id };
}

/** Insert/remove the demo contract signature (drives the yellow banner). */
async function setSigned(ids: Awaited<ReturnType<typeof demoIds>>, signed: boolean) {
  if (signed) {
    const { data: existing } = await sb
      .from("signatures")
      .select("id")
      .eq("quote_id", ids.quoteId)
      .eq("kind", "contract")
      .maybeSingle();
    if (existing) return;
    const { error } = await sb.from("signatures").insert({
      kind: "contract",
      quote_id: ids.quoteId,
      lead_id: ids.leadId,
      client_id: ids.clientId,
      signer_name: DEMO_CUSTOMER.name,
      method: "typed",
      channel: "remote",
      acknowledgments: { training_demo: true },
    });
    if (error) throw error;
  } else {
    const { error } = await sb.from("signatures").delete().eq("quote_id", ids.quoteId).eq("kind", "contract");
    if (error) throw error;
  }
}

// ---- filming helpers --------------------------------------------------------
const TAP_INIT = `
  (() => {
    const style = document.createElement("style");
    style.textContent =
      "nextjs-portal{display:none!important}" + /* hide the Next dev badge/toasts */
      ".__tapdot{position:fixed;z-index:2147483647;width:44px;height:44px;margin:-22px 0 0 -22px;" +
      "border-radius:50%;background:rgba(192,56,56,.45);border:2px solid rgba(192,56,56,.9);" +
      "pointer-events:none;transform:scale(.6);opacity:0;transition:opacity .15s ease,transform .35s ease}" +
      ".__tapdot.show{opacity:1;transform:scale(1)}" +
      ".__tapdot.pulse{transform:scale(1.6);opacity:0;transition:opacity .45s ease,transform .45s ease}";
    document.addEventListener("DOMContentLoaded", () => document.head.appendChild(style));
    if (document.head) document.head.appendChild(style.cloneNode(true));
    window.__tap = (x, y) => {
      let d = document.querySelector(".__tapdot");
      if (!d) { d = document.createElement("div"); d.className = "__tapdot"; document.body.appendChild(d); }
      d.style.left = x + "px"; d.style.top = y + "px";
      d.classList.remove("pulse"); void d.offsetWidth; d.classList.add("show");
    };
    window.__tapGo = () => {
      const d = document.querySelector(".__tapdot");
      if (d) { d.classList.add("pulse"); setTimeout(() => d.classList.remove("show","pulse"), 500); }
    };
  })();
`;

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Deliberate tap: settle, show the finger dot on the target, hold ~1s, ripple, click. */
async function tap(page: Page, locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  await pause(900);
  const box = await locator.boundingBox();
  if (box) {
    await page.evaluate(
      ([x, y]) => (window as unknown as { __tap(x: number, y: number): void }).__tap(x, y),
      [box.x + box.width / 2, box.y + box.height / 2],
    );
    await pause(700);
    await page.evaluate(() => (window as unknown as { __tapGo(): void }).__tapGo());
  }
  await locator.click({ delay: 60 });
}

async function smoothScroll(page: Page, y: number, settleMs = 1300) {
  await page.evaluate((top) => window.scrollTo({ top, behavior: "smooth" }), y);
  await pause(settleMs);
}

/** Draw a small signature squiggle on a canvas signature pad. */
async function squiggle(page: Page, canvas: Locator) {
  const box = await canvas.boundingBox();
  if (!box) return;
  const baseX = box.x + box.width * 0.2;
  const baseY = box.y + box.height * 0.55;
  await page.mouse.move(baseX, baseY);
  await page.mouse.down();
  const pts = 22;
  for (let i = 1; i <= pts; i++) {
    const x = baseX + (box.width * 0.6 * i) / pts;
    const y = baseY + Math.sin(i / 2.2) * box.height * 0.16;
    await page.mouse.move(x, y, { steps: 2 });
    await pause(18);
  }
  await page.mouse.up();
}

// ---- takes ------------------------------------------------------------------
async function take(
  ctx: BrowserContext,
  id: string,
  minSec: number,
  run: (page: Page) => Promise<void>,
): Promise<void> {
  const page = await ctx.newPage();
  const started = Date.now();
  try {
    await run(page);
    // Hold so the clip always outlasts its narration window (+pad for trims).
    const target = (minSec + 4) * 1000;
    const remaining = target - (Date.now() - started);
    if (remaining > 0) await pause(remaining);
  } finally {
    await page.close();
    const video = page.video();
    if (video) await video.saveAs(path.join(footageDir, `${id}.webm`));
  }
  console.log(`take   ${id}  (${((Date.now() - started) / 1000).toFixed(1)}s)`);
}

async function main() {
  const ids = await demoIds();
  // The onboarding tour would overlay the first visit — mark it seen (dev login).
  const { data: prof } = await sb.from("profiles").select("id").eq("email", CREW_LOGIN.email).single();
  if (prof) await sb.from("profiles").update({ tour_seen_at: new Date().toISOString() }).eq("id", prof.id);

  rmSync(footageDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    colorScheme: "light",
    // NOTE: Playwright captures at CSS-pixel resolution and never scales UP —
    // asking for 780x1688 just pads 390x844 content with grey. Record exact.
    recordVideo: { dir: tmpDir, size: { width: 390, height: 844 } },
    permissions: ["camera", "microphone"],
  });
  await ctx.addInitScript(TAP_INIT);
  ctx.setDefaultNavigationTimeout(60_000); // dev-server compiles can be slow

  // Login + route warm-up on a throwaway page (video discarded with tmp dir).
  {
    const page = await ctx.newPage();
    await page.goto(`${BASE_URL}/login`, { waitUntil: "load" });
    await pause(2500); // let React hydrate — a pre-hydration click submits nothing
    await page.fill("#email", CREW_LOGIN.email);
    await page.fill("#password", CREW_LOGIN.password);
    await page.click("button[type=submit]");
    await page.waitForURL("**/my-jobs", { timeout: 60_000 });
    // Warm the dev-compiled routes so takes never film a compiling screen.
    await page.goto(`${BASE_URL}/my-jobs/${ids.apptId}`, { waitUntil: "load" });
    await page.goto(`${BASE_URL}/my-jobs/manual`, { waitUntil: "load" });
    await page.close();
  }

  const jobUrl = `${BASE_URL}/my-jobs/${ids.apptId}`;

  // Part 1 — day list + week strip (banner state irrelevant).
  await take(ctx, "part-1", audioSec("part-1"), async (page) => {
    await page.goto(`${BASE_URL}/my-jobs`, { waitUntil: "load" });
    await pause(2500);
    await smoothScroll(page, 220);
    await pause(1200);
    await smoothScroll(page, 0);
  });

  // Parts 2-3 film the SIGNED state (no yellow banner).
  await setSigned(ids, true);

  // Part 2 — tap the job card, read the job, scroll to the item list.
  await take(ctx, "part-2", audioSec("part-2"), async (page) => {
    await page.goto(`${BASE_URL}/my-jobs`, { waitUntil: "load" });
    await pause(1500);
    await tap(page, page.locator(`a[href="/my-jobs/${ids.apptId}"]`).first());
    await page.waitForURL(`**/my-jobs/${ids.apptId}`);
    await pause(2200);
    await smoothScroll(page, 500, 1500);
    // Survey inventory (with the "Not moving — leave in place" pill).
    await page.getByText("Not moving — leave in place").first().scrollIntoViewIfNeeded();
    await pause(2000);
  });

  // Part 3 — Directions + Call.
  await take(ctx, "part-3", audioSec("part-3"), async (page) => {
    await page.goto(jobUrl, { waitUntil: "load" });
    await pause(1800);
    const directions = page.getByRole("link", { name: "Directions" }).first();
    await tap(page, directions); // opens a popup page (its video is discarded)
    await pause(1800);
    const popup = ctx.pages().at(-1);
    if (popup && popup !== page) await popup.close();
    await pause(800);
  });

  // Part 4 — UNSIGNED: yellow banner + collect-signature dialog (cancelled).
  await setSigned(ids, false);
  await take(ctx, "part-4", audioSec("part-4"), async (page) => {
    await page.goto(jobUrl, { waitUntil: "load" });
    await pause(2500); // banner front and centre
    await tap(page, page.getByRole("button", { name: "Collect signature now" }));
    await pause(1800);
    const ack = page.locator("[role=dialog] input[type=checkbox]").first();
    await tap(page, ack);
    await pause(600);
    const pad = page.locator("[role=dialog] canvas").first();
    await pad.scrollIntoViewIfNeeded();
    await pause(800);
    await squiggle(page, pad);
    await pause(1500);
    await page.getByRole("button", { name: "Cancel" }).click(); // never saved
  });
  await setSigned(ids, true);

  // Part 5 — capture sheet: Photo / Video / Voice tray (nothing recorded).
  await take(ctx, "part-5", audioSec("part-5"), async (page) => {
    await page.goto(jobUrl, { waitUntil: "load" });
    await pause(1500);
    await tap(page, page.getByRole("button", { name: "Capture photos, video or a voice note" }));
    await pause(2200);
    const voiceTab = page.getByRole("tab", { name: /voice/i }).first();
    if (await voiceTab.isVisible().catch(() => false)) {
      await tap(page, voiceTab);
      await pause(2000);
      const photoTab = page.getByRole("tab", { name: /photo/i }).first();
      if (await photoTab.isVisible().catch(() => false)) await tap(page, photoTab);
    }
    await pause(1500);
    await page.getByRole("button", { name: "Close" }).first().click();
  });

  // Part 6 — Complete job dialog (filled a little, then cancelled).
  await take(ctx, "part-6", audioSec("part-6"), async (page) => {
    await page.goto(jobUrl, { waitUntil: "load" });
    await pause(1500);
    await tap(page, page.getByRole("button", { name: "Complete job" }));
    await pause(1800);
    await page.locator("#exceptions").click();
    await page.locator("#exceptions").pressSequentially("Nothing to report", { delay: 55 });
    await pause(900);
    const custPad = page.locator("[role=dialog] canvas").first();
    await custPad.scrollIntoViewIfNeeded();
    await pause(800);
    await squiggle(page, custPad);
    await pause(1400);
    await page.getByRole("button", { name: "Cancel" }).click(); // never signed off
  });

  // Part 7 — the job sheet PDF.
  await take(ctx, "part-7", audioSec("part-7"), async (page) => {
    await page.goto(jobUrl, { waitUntil: "load" });
    await pause(1800);
    const dl = page.waitForEvent("download", { timeout: 30_000 }).catch(() => null);
    await tap(page, page.getByRole("button", { name: /job sheet/i }).first());
    const d = await dl; // discard the PDF; the tap + loading state is the shot
    if (d) await d.cancel().catch(() => {});
    await pause(2500);
  });

  // Part 8 — "Your device": install, quick sign-in, alerts, manual.
  await take(ctx, "part-8", audioSec("part-8"), async (page) => {
    await page.goto(`${BASE_URL}/my-jobs`, { waitUntil: "load" });
    await pause(1500);
    const device = page.getByRole("heading", { name: "Your device" });
    await device.scrollIntoViewIfNeeded();
    await smoothScroll(page, await page.evaluate(() => document.body.scrollHeight), 1800);
    await pause(2200);
    await tap(page, page.getByRole("link", { name: /User manual/i }));
    await page.waitForURL("**/my-jobs/manual");
    await pause(1500);
    await smoothScroll(page, 420, 1600);
  });

  // Restore the seed's unsigned state (the banner demo is the default).
  await setSigned(ids, false);

  await ctx.close();
  await browser.close();
  rmSync(tmpDir, { recursive: true, force: true });
  console.log(`\nfootage saved to ${footageDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
