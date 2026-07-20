/**
 * Artefact reviewer (PRD B5). After an E2E run, pass the captured screenshots +
 * emails to an LLM and ask the single question: "Does anything here look wrong
 * to a human?" — layout breakage, placeholder text, odd formatting, wrong tone.
 *
 * STRICTLY ADVISORY. It never auto-passes or auto-fails a run (always exits 0),
 * never drives the system, and never touches payments — it only writes
 * e2e/artefacts/review.md for a human to skim. Fail-soft: any API/setup problem
 * is written to the report, not thrown.
 *
 * Usage:  ANTHROPIC_API_KEY=… node e2e/artefacts/review.mjs
 */
import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = "e2e/artefacts";
const OUT = join(ROOT, "review.md");
const MODEL = process.env.E2E_REVIEW_MODEL || "claude-sonnet-5";
const MAX_IMAGES_PER_TEST = 6;

const write = (body) => writeFileSync(OUT, `# E2E artefact review\n\n${body}\n`);

function collectTestDirs() {
  if (!existsSync(ROOT)) return [];
  return readdirSync(ROOT)
    .map((n) => join(ROOT, n))
    .filter((p) => {
      try {
        return statSync(p).isDirectory() && !["report", "_output"].includes(p.split("/").pop());
      } catch {
        return false;
      }
    });
}

async function reviewDir(dir, apiKey) {
  const files = readdirSync(dir);
  const images = files.filter((f) => f.endsWith(".png")).slice(0, MAX_IMAGES_PER_TEST);
  const emails = files.filter((f) => f.endsWith(".html"));

  const content = [
    {
      type: "text",
      text:
        `These are artefacts from the E2E step "${dir.split("/").pop()}" of Marley Moves (a UK removals ops app). ` +
        `As a careful human reviewer, flag anything that looks WRONG: broken/overlapping layout, placeholder text ` +
        `("undefined", "{{token}}", "NaN", "[object Object]"), mis-formatted money (must be like £1,800.00) or dates ` +
        `(UK), or an off/unprofessional tone. If everything looks fine, say so briefly. Advisory only.`,
    },
  ];
  for (const img of images) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: readFileSync(join(dir, img)).toString("base64") },
    });
  }
  for (const e of emails) {
    content.push({ type: "text", text: `Email HTML (${e}):\n` + readFileSync(join(dir, e), "utf8").slice(0, 20_000) });
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 700, messages: [{ role: "user", content }] }),
  });
  if (!res.ok) return `_review failed (${res.status})_`;
  const json = await res.json();
  return (json.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim() || "_no response_";
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const dirs = collectTestDirs();
  if (!dirs.length) return write("No artefacts found — run the suite first.");
  if (!apiKey) return write("Set ANTHROPIC_API_KEY to enable the LLM review. Artefacts are in e2e/artefacts/.");

  const sections = [];
  for (const dir of dirs) {
    process.stdout.write(`Reviewing ${dir}… `);
    let out;
    try {
      out = await reviewDir(dir, apiKey);
    } catch (e) {
      out = `_review errored: ${e instanceof Error ? e.message : String(e)}_`;
    }
    console.log("done");
    sections.push(`## ${dir.split("/").pop()}\n\n${out}`);
  }
  write(`Advisory only — a human decides. Model: ${MODEL}.\n\n${sections.join("\n\n")}`);
  console.log(`\nWrote ${OUT}`);
}

main().catch((e) => {
  write(`Reviewer crashed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(0); // never fail a pipeline on the advisory review
});
