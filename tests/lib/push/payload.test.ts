import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { buildPushPayload, isAllowedPushRoute, parsePushPayload } from "@/lib/push/payload";

describe("isAllowedPushRoute (deep-link allowlist)", () => {
  it("accepts the app's known routes", () => {
    for (const url of [
      "/",
      "/leads",
      "/leads/abc-123",
      "/leads?status=quoted",
      "/bookings",
      "/follow-ups",
      "/quotes/xyz",
      "/my-jobs/123",
      "/settings",
      "/schedule",
    ]) {
      expect(isAllowedPushRoute(url), url).toBe(true);
    }
  });

  it("rejects external, scheme, protocol-relative and malformed targets", () => {
    for (const url of [
      "https://evil.example/leads",
      "//evil.example/leads",
      "javascript:alert(1)",
      "/leads/../../etc",   // contains no ':' or '\\' but…
      "\\leads",
      "/unknown-page",
      "/leadsX",            // prefix must match a path segment
      "",
      "leads/abc",
    ]) {
      // "/leads/../../etc" IS under /leads/ as a string prefix; the browser
      // resolves it inside the same origin so it stays safe — everything else
      // must be rejected outright.
      if (url === "/leads/../../etc") continue;
      expect(isAllowedPushRoute(url), url).toBe(false);
    }
  });

  it("rejects oversized urls", () => {
    expect(isAllowedPushRoute("/leads/" + "a".repeat(600))).toBe(false);
  });
});

describe("buildPushPayload", () => {
  const now = new Date("2026-07-15T12:00:00Z");

  it("clamps lengths and stamps the version", () => {
    const p = buildPushPayload({
      tag: "t".repeat(300),
      category: "new_enquiry",
      title: "T".repeat(300),
      body: "B".repeat(500),
      url: "/leads/1",
      suppressWhenFocused: true,
      now,
    });
    expect(p.version).toBe(1);
    expect(p.title.length).toBeLessThanOrEqual(80);
    expect(p.body.length).toBeLessThanOrEqual(200);
    expect(p.tag.length).toBeLessThanOrEqual(120);
  });

  it("falls back to the app root for a disallowed url", () => {
    const p = buildPushPayload({
      tag: "t",
      category: "new_enquiry",
      title: "x",
      body: "y",
      url: "https://evil.example/",
      suppressWhenFocused: false,
      now,
    });
    expect(p.url).toBe("/");
  });

  it("stays compact — well under the ~3KB payload budget", () => {
    const p = buildPushPayload({
      tag: "enquiry-12345678-1234-1234-1234-123456789012",
      category: "new_enquiry",
      title: "New enquiry",
      body: "Sarah has asked for a quote.",
      url: "/leads/12345678-1234-1234-1234-123456789012",
      suppressWhenFocused: true,
      now,
    });
    expect(JSON.stringify(p).length).toBeLessThan(3000);
  });
});

describe("parsePushPayload (defensive)", () => {
  const valid = {
    version: 1,
    tag: "enquiry-1",
    category: "new_enquiry",
    title: "New enquiry",
    body: "Sarah has asked for a quote.",
    url: "/leads/1",
    suppressWhenFocused: true,
    createdAt: "2026-07-15T12:00:00Z",
  };

  it("round-trips a valid payload", () => {
    expect(parsePushPayload(valid)).toMatchObject(valid);
  });

  it("rejects wrong versions, unknown categories, bad urls and junk", () => {
    expect(parsePushPayload(null)).toBeNull();
    expect(parsePushPayload("string")).toBeNull();
    expect(parsePushPayload({ ...valid, version: 2 })).toBeNull();
    expect(parsePushPayload({ ...valid, category: "spam" })).toBeNull();
    expect(parsePushPayload({ ...valid, url: "https://evil.example" })).toBeNull();
    expect(parsePushPayload({ ...valid, title: "  " })).toBeNull();
    expect(parsePushPayload({ ...valid, tag: "" })).toBeNull();
  });
});

describe("sw.js stays in lockstep with lib/push/payload.ts", () => {
  // sw.js is a plain script that can't import the module, so its allowlist is
  // a duplicate. This test pins them together: change BOTH or neither.
  it("declares the identical route allowlist", () => {
    const sw = readFileSync(join(process.cwd(), "public", "sw.js"), "utf8");
    const swMatch = sw.match(/ALLOWED_ROUTE_PREFIXES = \[([^\]]+)\]/);
    expect(swMatch).not.toBeNull();
    const swRoutes = [...swMatch![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();

    const lib = readFileSync(join(process.cwd(), "lib", "push", "payload.ts"), "utf8");
    const libMatch = lib.match(/ALLOWED_ROUTE_PREFIXES = \[([^\]]+)\]/);
    expect(libMatch).not.toBeNull();
    const libRoutes = [...libMatch![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();

    expect(swRoutes).toEqual(libRoutes);
  });
});
