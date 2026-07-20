import { defineConfig } from "@playwright/test";

/**
 * Marley Ops end-to-end suite (crew-reliability PRD Phase B).
 *
 * Env-agnostic: runs against whatever `E2E_BASE_URL` points at — a staging
 * deployment (the intended CI target) or a local `npm run dev` on :3015. The
 * app moved off Vercel to the OVH box, so "staging" is a separate deployment
 * you stand up, not a Vercel preview; nothing here assumes Vercel.
 *
 * NEVER point this at production: the flows sign in, create records and (in the
 * card scenarios) drive the takepayments SANDBOX. A live card payment creates a
 * real VAT tax point. Guarded in globalSetup + the seed script.
 *
 * Browsers: this repo's environment ships only Chromium (webkit isn't
 * installed), so every project pins chromium; the crew/customer projects use a
 * phone-sized viewport rather than a webkit device descriptor.
 */

const BASE_URL = process.env.E2E_BASE_URL || "http://localhost:3015";

const authDir = "e2e/fixtures/.auth";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./e2e/artefacts/_output",
  globalSetup: "./e2e/fixtures/global-setup.ts",
  // Shared seeded DB state → run serially so tests don't race each other's data.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 10_000 }, // web-first assertions poll up to here — no hardcoded waits
  reporter: [
    ["list"],
    ["html", { outputFolder: "e2e/artefacts/report", open: "never" }],
    ["json", { outputFile: "e2e/artefacts/results.json" }],
  ],
  use: {
    baseURL: BASE_URL,
    browserName: "chromium",
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure", // per-step full-page shots are taken explicitly via step()
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    // Signs in each role once and stores its session (storageState).
    { name: "setup", testMatch: /auth\.setup\.ts/ },

    {
      name: "crew",
      dependencies: ["setup"],
      testMatch: /(journeys\/crew|scenarios\/p0)\.spec\.ts/,
      use: { storageState: `${authDir}/crew.json`, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    },
    {
      name: "office",
      dependencies: ["setup"],
      testMatch: /journeys\/office\.spec\.ts/,
      use: { storageState: `${authDir}/office.json`, viewport: { width: 1280, height: 900 } },
    },
    {
      name: "estimator",
      dependencies: ["setup"],
      testMatch: /journeys\/estimator\.spec\.ts/,
      use: { storageState: `${authDir}/estimator.json`, viewport: { width: 1280, height: 900 } },
    },
    {
      // Customer-facing public pages (/q, /s) — no auth, phone-sized.
      name: "public",
      dependencies: ["setup"],
      testMatch: /journeys\/customer\.spec\.ts/,
      use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    },
  ],
});
