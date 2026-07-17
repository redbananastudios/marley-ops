/**
 * Films the crew walkthrough footage against a LOCAL dev server + LOCAL
 * Supabase (guarded — refuses non-local URLs). One .webm per manual section
 * (9 parts) into crew/footage/.
 *
 * RETINA CAPTURE (v2): Playwright's recordVideo never upscales — it captures
 * the page picture at CSS-pixel size. So the only lever for crisp footage is a
 * bigger CSS viewport that STILL renders the phone layout. Both crew pages use
 * `max-w-2xl` and only break to two columns at `sm` (640px), so 585x1266 (1.5x
 * of 390x844, same 0.462 aspect, under 640) stays single-column phone AND gives
 * 2.25x the source pixels. The Remotion phone frame then DOWNSCALES it → crisp.
 *
 * PAUSES (v2): tap() holds ~1.1s with the target ring sat ON the control
 * BEFORE the click, and ~0.7s after, so a viewer can follow. point() marks a
 * control WITHOUT clicking (used where a real click opens a native picker or a
 * download and adds nothing on screen).
 *
 * Contract state is toggled per take: parts 2/3/5/6/7/8 film SIGNED (no
 * banner), part 4 films UNSIGNED so the yellow collect-signature banner shows.
 * Part 6 films with media_consent UNSET so the first-capture consent card
 * appears. Nothing is ever submitted that matters: sign-off + contract dialogs
 * are cancelled; the one saved Crew note (part 5) is training data the
 * --cleanup pass deletes with the demo lead.
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

// Re-film a subset after a UI/timing change (e.g. ONLY=part-6) — the existing
// clips are kept, state toggles + warm-up still run. Empty = film everything.
const ONLY = (process.env.ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const wants = (id: string) => ONLY.length === 0 || ONLY.includes(id);

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

/** Reset the lead's marketing consent to 'unset' so the capture sheet shows its
 *  first-capture consent card (part 6). A prior run's "Customer's OK'd it" tap
 *  would otherwise leave it 'granted' and the card would never appear. The
 *  column is NOT NULL (default 'unset'), so write the string, not null. */
async function setConsentUnset(ids: Awaited<ReturnType<typeof demoIds>>) {
  const { error } = await sb.from("leads").update({ media_consent: "unset" }).eq("id", ids.leadId);
  if (error) throw error;
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

/** Put the red target ring on a locator's centre (the "look HERE" marker). */
async function ringOn(page: Page, locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) return;
  await page.evaluate(
    ([x, y]) => (window as unknown as { __tap(x: number, y: number): void }).__tap(x, y),
    [box.x + box.width / 2, box.y + box.height / 2],
  );
}

/**
 * Deliberate tap (the pause rule): scroll in, settle, drop the ring ON the
 * control, HOLD ~1.1s so it's readable, ripple, click, then HOLD ~0.7s so the
 * result registers. Never cuts on the action frame.
 */
async function tap(page: Page, locator: Locator, { holdBefore = 1100, holdAfter = 700 } = {}) {
  await locator.scrollIntoViewIfNeeded();
  await pause(500);
  await ringOn(page, locator);
  await pause(holdBefore);
  await page.evaluate(() => (window as unknown as { __tapGo(): void }).__tapGo());
  await locator.click({ delay: 60 });
  await pause(holdAfter);
}

/**
 * Point at a control WITHOUT clicking — the ring lands, holds, ripples. Used
 * for targets a real click would ruin the shot on (native file picker, tel:
 * dial, a download), where "look here, this is the button" is the whole beat.
 */
async function point(page: Page, locator: Locator, { hold = 1300 } = {}) {
  await locator.scrollIntoViewIfNeeded();
  await pause(500);
  await ringOn(page, locator);
  await pause(hold);
  await page.evaluate(() => (window as unknown as { __tapGo(): void }).__tapGo());
  await pause(500);
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
  if (!wants(id)) return; // subset re-film — keep the existing clip
  const page = await ctx.newPage();
  const started = Date.now();
  try {
    await run(page);
    // Hold so the clip always outlasts its narration window (+pad for the
    // section tail and the longer per-tap holds).
    const target = (minSec + 5) * 1000;
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

  if (ONLY.length === 0) rmSync(footageDir, { recursive: true, force: true }); // full run wipes; subset keeps
  mkdirSync(tmpDir, { recursive: true });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    // Retina capture: 585x1266 = 1.5x of 390x844 (same 0.462 aspect), still
    // under the sm(640) breakpoint so both crew pages stay single-column phone.
    // recordVideo captures at CSS-pixel size and never scales UP, so a bigger
    // viewport is the ONLY way to feed the phone frame more real detail; the
    // Remotion frame then downscales 585 → ~440 = crisp. DSF 3 sharpens the
    // rasterised text within those CSS pixels before the screencast samples it.
    viewport: { width: 585, height: 1266 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    colorScheme: "light",
    recordVideo: { dir: tmpDir, size: { width: 585, height: 1266 } },
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

  // Part 1 — day list + week strip (banner state irrelevant on /my-jobs).
  await take(ctx, "part-1", audioSec("part-1"), async (page) => {
    await page.goto(`${BASE_URL}/my-jobs`, { waitUntil: "load" });
    await pause(2500);
    // Today's tile carries a red count on the week strip.
    await point(page, page.locator('[aria-label="1 job"]').first());
    // The job card that opens the job.
    await point(page, page.locator('[data-tour="crew-job-card"]').first());
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
    await smoothScroll(page, 640, 1500);
    // Survey inventory (with the "Not moving — leave in place" pill).
    await page.getByText("Not moving — leave in place").first().scrollIntoViewIfNeeded();
    await pause(2200);
  });

  // Part 3 — Directions (address card) + Call (cab bar). Point, don't click:
  // a real tap dials/opens maps and adds nothing on screen.
  await take(ctx, "part-3", audioSec("part-3"), async (page) => {
    await page.goto(jobUrl, { waitUntil: "load" });
    await pause(1800);
    await point(page, page.getByRole("link", { name: "Directions" }).first());
    await point(page, page.getByRole("link", { name: /^Call/ }).first());
  });

  // Part 4 — UNSIGNED: yellow banner + collect-signature dialog (cancelled).
  await setSigned(ids, false);
  await take(ctx, "part-4", audioSec("part-4"), async (page) => {
    await page.goto(jobUrl, { waitUntil: "load" });
    await pause(2500); // banner front and centre
    await tap(page, page.getByRole("button", { name: "Collect signature now" }));
    await pause(1500);
    await tap(page, page.locator("[role=dialog] input[type=checkbox]").first());
    const pad = page.locator("[role=dialog] canvas").first();
    await pad.scrollIntoViewIfNeeded();
    await pause(800);
    await squiggle(page, pad);
    await pause(1500);
    await page.getByRole("button", { name: "Cancel" }).click(); // never saved
  });
  await setSigned(ids, true);

  // Part 5 — a PROBLEM → Crew notes & photos (PRIVATE, office-only). Type a
  // note, point the Add-photos camera, save it (the saved row is cleaned up).
  await take(ctx, "part-5", audioSec("part-5"), async (page) => {
    await page.goto(jobUrl, { waitUntil: "load" });
    await pause(1500);
    await page.getByText("Crew notes & photos").first().scrollIntoViewIfNeeded();
    await pause(1200);
    const noteBox = page.getByPlaceholder(/Add a note/i);
    await tap(page, noteBox, { holdBefore: 800, holdAfter: 300 });
    await noteBox.pressSequentially("Wardrobe door already scratched. Photo added.", { delay: 42 });
    await pause(900);
    await point(page, page.getByText("Add photos").first()); // native picker — don't click
    await tap(page, page.getByRole("button", { name: "Save note" }));
    await pause(1800); // success toast + the note lands in the list
  });

  // Part 6 — a GOOD MOMENT → the red camera (marketing) + the CONSENT card.
  // media_consent must be unset so the first-capture consent card appears.
  await setConsentUnset(ids);
  await take(ctx, "part-6", audioSec("part-6"), async (page) => {
    await page.goto(jobUrl, { waitUntil: "load" });
    await pause(1500);
    // The round RED camera FAB (different from the notes camera).
    await tap(page, page.getByRole("button", { name: "Capture photos, video or a voice note" }));
    await pause(2800); // sheet opens; consent card reads
    await point(page, page.getByRole("tablist", { name: /capture mode/i })); // Photo/Video/Voice
    // Hold on the consent card while the narration explains it (van/outside/team
    // fine, ask before shooting inside) — the card must stay on screen for it.
    await pause(6500);
    // The consent step lands here, when the narration says "tap Customer's OK'd it".
    await tap(page, page.getByRole("button", { name: /Customer.s OK.d it/i }));
    // Do NOT close: hold the granted state (header now reads "Customer OK'd
    // marketing use") to the end so the consent narration never plays over an
    // empty job page. The take's own hold outlasts the window.
    await pause(2500);
  });

  // Part 7 — Complete job dialog (filled a little, then cancelled).
  await take(ctx, "part-7", audioSec("part-7"), async (page) => {
    await page.goto(jobUrl, { waitUntil: "load" });
    await pause(1500);
    await tap(page, page.getByRole("button", { name: "Complete job" }));
    await pause(1200);
    const exc = page.locator("#exceptions");
    await tap(page, exc, { holdBefore: 700, holdAfter: 300 });
    await exc.pressSequentially("Nothing to report", { delay: 50 });
    await pause(900);
    const custPad = page.locator("[role=dialog] canvas").first();
    await custPad.scrollIntoViewIfNeeded();
    await pause(800);
    await squiggle(page, custPad);
    await pause(1500);
    await page.getByRole("button", { name: "Cancel" }).click(); // never signed off
  });

  // Part 8 — the job sheet PDF (tap → loading state → download intercepted).
  await take(ctx, "part-8", audioSec("part-8"), async (page) => {
    await page.goto(jobUrl, { waitUntil: "load" });
    await pause(1800);
    const dl = page.waitForEvent("download", { timeout: 30_000 }).catch(() => null);
    await tap(page, page.getByRole("button", { name: /job sheet/i }).first());
    const d = await dl; // discard the PDF; the tap + loading state is the shot
    if (d) await d.cancel().catch(() => {});
    await pause(2500);
  });

  // Part 9 — "Your device": install, quick sign-in, alerts, manual.
  await take(ctx, "part-9", audioSec("part-9"), async (page) => {
    await page.goto(`${BASE_URL}/my-jobs`, { waitUntil: "load" });
    await pause(1500);
    await page.getByRole("heading", { name: "Your device" }).scrollIntoViewIfNeeded();
    await smoothScroll(page, await page.evaluate(() => document.body.scrollHeight), 1600);
    await pause(2400); // install / alerts / fingerprint rows on screen
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
