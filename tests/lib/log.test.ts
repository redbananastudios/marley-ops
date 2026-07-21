import { afterEach, describe, expect, it, vi } from "vitest";
import { log } from "@/lib/log";

describe("structured log envelope", () => {
  afterEach(() => vi.restoreAllMocks());

  it("preserves canonical fields and redacts sensitive nested keys", () => {
    const output = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    log.warn("real.event", {
      level: "error",
      event: "spoofed",
      ts: "yesterday",
      authorization: "Bearer secret",
      email: "person@example.com",
      nested: { apiKey: "abc", safe: "failed for person@example.com on 07572 382 366" },
    });
    const line = JSON.parse(String(output.mock.calls[0][0])) as Record<string, unknown>;
    expect(line).toMatchObject({ schemaVersion: 1, service: "marley-ops", level: "warn", event: "real.event" });
    expect(line.ts).not.toBe("yesterday");
    expect(line.authorization).toBe("[redacted]");
    expect(line.email).toBe("[redacted]");
    expect(line.nested).toEqual({ apiKey: "[redacted]", safe: "failed for [redacted-email] on [redacted-phone]" });
  });

  it("stays valid JSON for circular and oversized context", () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const circular: Record<string, unknown> = { huge: "x".repeat(100_000) };
    circular.self = circular;
    log.info("large.event", { circular, many: Array.from({ length: 200 }, (_, index) => index) });
    const raw = String(output.mock.calls[0][0]);
    expect(raw.length).toBeLessThan(16_001);
    const line = JSON.parse(raw) as Record<string, unknown>;
    expect(line.event).toBe("large.event");
  });
});
