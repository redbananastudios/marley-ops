import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { CRON_JOBS } from "@/lib/cron/jobs";

function routeFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) files.push(...routeFiles(path));
    else if (entry.name === "route.ts") files.push(path);
  }
  return files;
}

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

  it("covers every cron/sync route that calls runCron", () => {
    const apiRoot = resolve(__dirname, "../../app/api");
    const discovered = ["cron", "sync"].flatMap((group) => routeFiles(resolve(apiRoot, group))).map((file) => {
      const source = readFileSync(file, "utf8");
      const slug = /runCron\(\s*["']([^"']+)["']/.exec(source)?.[1];
      expect(slug, file).toBeTruthy();
      const route = relative(apiRoot, file).split(sep).join("/").replace(/\/route\.ts$/, "");
      return { slug: slug!, endpoint: `/api/${route}` };
    });

    const registered = CRON_JOBS.map(({ slug, endpoint }) => ({ slug, endpoint }));
    expect(discovered.sort((a, b) => a.slug.localeCompare(b.slug))).toEqual(
      registered.sort((a, b) => a.slug.localeCompare(b.slug)),
    );
  });
});
