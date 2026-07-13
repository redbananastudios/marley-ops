import { describe, expect, it } from "vitest";
import { CRON_JOBS } from "@/lib/cron/jobs";

describe("CRON_JOBS registry", () => {
  it("has unique slugs and endpoints", () => {
    const slugs = CRON_JOBS.map((j) => j.slug);
    const endpoints = CRON_JOBS.map((j) => j.endpoint);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(new Set(endpoints).size).toBe(endpoints.length);
  });

  it("every endpoint is an app-relative API GET path", () => {
    for (const j of CRON_JOBS) {
      expect(j.endpoint, j.slug).toMatch(/^\/api\/(cron|sync)\//);
    }
  });
});
