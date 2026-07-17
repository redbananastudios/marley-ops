/**
 * Render the crew training video, stamping the outro with the current repo
 * short SHA (the build the footage was captured against). Output ->
 * ../crew/out/training-crew-v1.mp4.
 *
 * Run from training/video/:  node render.mjs
 * (or `npm run render`, which syncs assets first).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "..", "crew", "out", "training-crew-v1.mp4");
mkdirSync(path.dirname(out), { recursive: true });

let sha = "dev";
try {
  sha = execFileSync("git", ["-C", here, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
} catch {
  /* not a git checkout — keep "dev" */
}

execFileSync(
  "npx",
  ["remotion", "render", "CrewTraining", out, "--props", JSON.stringify({ sha })],
  { cwd: here, stdio: "inherit", shell: process.platform === "win32" },
);
console.log(`\nrendered ${out}  (stamped v ${sha})`);
