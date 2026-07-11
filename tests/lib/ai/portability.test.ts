import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../..");
const AI_ROOTS = ["lib/ai", "lib/storage", "app/api/ai-surveys", "app/api/cron/ai-jobs"];
const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs"]);

function codeFiles(path: string): string[] {
  const absolute = join(ROOT, path);
  try {
    if (statSync(absolute).isFile()) return [absolute];
  } catch {
    return [];
  }
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const child = join(absolute, entry.name);
    if (entry.isDirectory()) return codeFiles(relative(ROOT, child));
    const extension = entry.name.slice(entry.name.lastIndexOf("."));
    return CODE_EXTENSIONS.has(extension) ? [child] : [];
  });
}

describe("AI survey portability guardrails", () => {
  const files = AI_ROOTS.flatMap(codeFiles);

  it("contains no deployment-specific host literals", () => {
    const banned = [
      "supabase.redbananastudios.com",
      "ops.marleymoves.co.uk",
      "vercel",
    ];
    const violations = files.flatMap((file) => {
      const source = readFileSync(file, "utf8").toLowerCase();
      return banned
        .filter((literal) => source.includes(literal))
        .map((literal) => `${relative(ROOT, file)}: ${literal}`);
    });
    expect(violations).toEqual([]);
  });

  it("confines direct Supabase Storage SDK access to its driver", () => {
    const violations = files
      .filter((file) => relative(ROOT, file) !== "lib\\storage\\supabase-media-store.ts")
      .filter((file) => /\.storage\s*\.from\s*\(/.test(readFileSync(file, "utf8")))
      .map((file) => relative(ROOT, file));
    expect(violations).toEqual([]);
  });

  it("keeps migration 0031 free of provider storage schema", () => {
    const migration = readFileSync(
      join(ROOT, "supabase/migrations/0031_ai_cubic_survey.sql"),
      "utf8",
    );
    expect(migration).not.toMatch(/\bstorage\.(?:buckets|objects)\b/);
  });
});
