import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CACHE_VERSION,
  JOBS_DOC_CACHE,
  STATIC_CACHE,
  OFFLINE_URL,
  MANAGED_CACHES,
  WARM_HEADER,
  isCrewJobDoc,
  isImmutableAsset,
} from "@/lib/pwa/cache-rules";

describe("isCrewJobDoc", () => {
  it("matches the crew list and any job sub-path", () => {
    expect(isCrewJobDoc("/my-jobs")).toBe(true);
    expect(isCrewJobDoc("/my-jobs/abc-123")).toBe(true);
    expect(isCrewJobDoc("/my-jobs/pay")).toBe(true);
  });
  it("does not match office or unrelated routes", () => {
    for (const p of ["/", "/leads", "/jobs", "/my-jobsx", "/api/version", "/login"]) {
      expect(isCrewJobDoc(p), p).toBe(false);
    }
  });
});

describe("isImmutableAsset", () => {
  it("matches only content-hashed build assets", () => {
    expect(isImmutableAsset("/_next/static/chunks/main-abc.js")).toBe(true);
    expect(isImmutableAsset("/_next/static/css/app.css")).toBe(true);
  });
  it("never matches mutable/auth/data paths", () => {
    for (const p of ["/_next/data/x.json", "/_next/image", "/api/cron/x", "/my-jobs", "/logo.png"]) {
      expect(isImmutableAsset(p), p).toBe(false);
    }
  });
});

describe("cache names", () => {
  it("are versioned and all managed", () => {
    expect(JOBS_DOC_CACHE).toContain(CACHE_VERSION);
    expect(STATIC_CACHE).toContain(CACHE_VERSION);
    expect(MANAGED_CACHES).toEqual([JOBS_DOC_CACHE, STATIC_CACHE]);
  });
});

// The SW is a plain script that duplicates these rules (it can't import). Pin
// the duplication so the two can't silently drift.
describe("public/sw.js mirrors the rules", () => {
  const sw = readFileSync(resolve(__dirname, "../../../public/sw.js"), "utf8");

  it("uses the same cache names, offline url and warm header", () => {
    expect(sw).toContain(JOBS_DOC_CACHE);
    expect(sw).toContain(STATIC_CACHE);
    expect(sw).toContain(OFFLINE_URL);
    expect(sw).toContain(WARM_HEADER);
  });

  it("guards the same crew-doc and immutable-asset predicates", () => {
    expect(sw).toContain('"/my-jobs"');
    expect(sw).toContain("/my-jobs/");
    expect(sw).toContain("/_next/static/");
  });
});
