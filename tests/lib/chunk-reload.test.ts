import { describe, it, expect } from "vitest";
import { isChunkLoadError } from "@/lib/chunk-reload";

describe("isChunkLoadError", () => {
  it("detects ChunkLoadError by name", () => {
    const e = new Error("boom");
    e.name = "ChunkLoadError";
    expect(isChunkLoadError(e)).toBe(true);
  });

  it("detects the known stale-chunk message shapes", () => {
    for (const m of [
      "Loading chunk 42 failed",
      "Loading chunk app-abc123 failed.",
      "Loading CSS chunk 7 failed",
      "Failed to fetch dynamically imported module: https://ops.marleymoves.co.uk/_next/static/chunks/x.js",
      "error loading dynamically imported module",
      "Importing a module script failed.",
    ]) {
      expect(isChunkLoadError(new Error(m)), m).toBe(true);
    }
  });

  it("ignores unrelated errors and non-objects", () => {
    expect(isChunkLoadError(new Error("Cannot read properties of undefined"))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
    expect(isChunkLoadError("Loading chunk 1 failed")).toBe(false); // not an Error object
    expect(isChunkLoadError({})).toBe(false);
  });
});
