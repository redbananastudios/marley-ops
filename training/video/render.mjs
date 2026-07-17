/**
 * Render the crew training video, stamping the outro with the current repo
 * short SHA (the build the footage was captured against). Output ->
 * ../crew/out/training-crew-v2.mp4.
 *
 * Run from training/video/:  node render.mjs
 * (or `npm run render`, which syncs assets first).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "..", "crew", "out", "training-crew-v2.mp4");
mkdirSync(path.dirname(out), { recursive: true });

let sha = "dev";
try {
  sha = execFileSync("git", ["-C", here, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
} catch {
  /* not a git checkout — keep "dev" */
}

// Pass props via a FILE, not inline JSON: the Windows shell strips the inner
// quotes of `--props {"sha":...}` so Remotion sees invalid JSON. A relative
// props file (no spaces/quotes) sidesteps the shell entirely.
const propsFile = path.join(here, "props.json");
writeFileSync(propsFile, JSON.stringify({ sha }));
try {
  execFileSync(
    "npx",
    ["remotion", "render", "CrewTraining", out, `--props=props.json`],
    { cwd: here, stdio: "inherit", shell: process.platform === "win32" },
  );
} finally {
  rmSync(propsFile, { force: true });
}
console.log(`\nrendered ${out}  (stamped v ${sha})`);
