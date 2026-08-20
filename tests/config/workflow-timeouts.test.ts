import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Every GitHub Actions job must set `timeout-minutes`. Without it a hung step
 * runs to GitHub's 6-hour default, and because the deploy workflows use
 * non-cancelling concurrency groups, one wedged job blocks every subsequent
 * push. Regression context: 2026-08-19, `npx playwright install` stalled 3.5h+
 * in staging.yml's `e2e` job — the required prod-promotion gate — so the e2e
 * suite silently never ran on the deployed commit (QA-20260820-01).
 *
 * Parsed line-by-line (the repo deliberately has no YAML dependency): job names
 * are the 2-space-indented keys under a top-level `jobs:`, and each job's block
 * runs until the next job or the next top-level key.
 */
describe("workflow job timeouts", () => {
  const workflowsDir = join(__dirname, "../../.github/workflows");

  function jobsMissingTimeout(file: string): string[] {
    const lines = readFileSync(join(workflowsDir, file), "utf8").split("\n");
    const missing: string[] = [];
    let inJobs = false;
    let currentJob: string | null = null;
    let currentJobHasTimeout = false;

    const finishJob = () => {
      if (currentJob && !currentJobHasTimeout) missing.push(currentJob);
      currentJob = null;
      currentJobHasTimeout = false;
    };

    for (const line of lines) {
      if (/^jobs:\s*$/.test(line)) {
        inJobs = true;
        continue;
      }
      if (!inJobs) continue;
      if (/^\S/.test(line)) {
        // Next top-level key — jobs block over.
        finishJob();
        inJobs = false;
        continue;
      }
      const jobName = line.match(/^ {2}([\w-]+):\s*$/);
      if (jobName) {
        finishJob();
        currentJob = jobName[1];
        continue;
      }
      if (currentJob && /^ {4}timeout-minutes:\s*\d+\s*$/.test(line)) {
        currentJobHasTimeout = true;
      }
    }
    finishJob();
    return missing;
  }

  const files = readdirSync(workflowsDir).filter((f) => /\.ya?ml$/.test(f));

  it("finds the workflow files (guards the parser against a moved directory)", () => {
    expect(files).toContain("staging.yml");
    expect(files).toContain("deploy.yml");
  });

  it.each(files)("%s sets timeout-minutes on every job", (file) => {
    expect(jobsMissingTimeout(file)).toEqual([]);
  });
});
