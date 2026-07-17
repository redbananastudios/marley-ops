/**
 * Copy the freshly generated narration audio + footage into the Remotion
 * public/ folder, transcoding the Playwright .webm clips to .mp4 (which
 * @remotion/media decodes deterministically). Run after crew/tts.mjs +
 * crew/record.ts, before `remotion render`.
 *
 * Run from training/video/:  node sync-assets.mjs
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const crew = path.join(here, "..", "crew");
const pub = path.join(here, "public");

mkdirSync(path.join(pub, "audio"), { recursive: true });
mkdirSync(path.join(pub, "footage"), { recursive: true });

// Audio + timing manifest.
for (const f of readdirSync(path.join(crew, "audio"))) {
  if (f.endsWith(".mp3")) cpSync(path.join(crew, "audio", f), path.join(pub, "audio", f));
}
cpSync(path.join(crew, "audio", "timeline.json"), path.join(pub, "timeline.json"));

// Footage: webm -> mp4 (H.264, yuv420p) for stable frame-accurate decoding.
for (const f of readdirSync(path.join(crew, "footage"))) {
  if (!f.endsWith(".webm")) continue;
  const base = f.replace(/\.webm$/, "");
  const out = path.join(pub, "footage", `${base}.mp4`);
  execFileSync(
    "ffmpeg",
    ["-y", "-loglevel", "error", "-i", path.join(crew, "footage", f), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-an", out],
    { stdio: "inherit" },
  );
  console.log("footage ->", `${base}.mp4`);
}
console.log("assets synced into video/public/");
