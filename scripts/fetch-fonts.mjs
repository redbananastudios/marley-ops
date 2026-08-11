/**
 * Download the webfonts the panel uses into app/fonts/, so the BUILD never
 * touches the network.
 *
 * Why this exists: app/layout.tsx used next/font/google, which fetches from
 * fonts.googleapis.com at build time. On 2026-08-11 that fetch failed inside
 * the Docker build and took the staging deploy down with a "module not found"
 * on geist_*.module.css; it passed on re-run. A release path that depends on a
 * third party being up is a release path that will fail at the worst moment,
 * and the failure reads as a code error rather than a network one, so it costs
 * a diagnosis every time.
 *
 * Re-run this only when adding a face or a weight:
 *   node scripts/fetch-fonts.mjs
 *
 * It asks Google for css2 with a modern browser UA (that's what makes them
 * serve woff2 rather than ttf), keeps the LATIN subset only — matching the
 * subsets: ["latin"] the app already declared — and writes one variable file
 * per family. All three faces are SIL Open Font License 1.1; see app/fonts/OFL.txt.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "app", "fonts");

// A real Chrome UA: Google serves ttf to anything it doesn't recognise.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36";

const FAMILIES = [
  { css: "Geist:wght@400..700", file: "geist-latin.woff2" },
  { css: "Geist+Mono:wght@400..600", file: "geist-mono-latin.woff2" },
  { css: "Cormorant+Garamond:wght@500..700", file: "cormorant-garamond-latin.woff2" },
];

/** The css2 response groups @font-face blocks under `/* subset *\/` comments. */
function latinWoff2Url(css) {
  const blocks = css.split(/\/\*\s*/).map((b) => b.trim());
  // Exact "latin" — never "latin-ext", which is a different (larger) file.
  const latin = blocks.find((b) => b.startsWith("latin *\/") || b.startsWith("latin */"));
  const source = latin ?? css;
  const m = /url\((https:\/\/[^)]+\.woff2)\)/.exec(source);
  if (!m) throw new Error("no woff2 url in the css2 response");
  return m[1];
}

await mkdir(OUT, { recursive: true });

for (const family of FAMILIES) {
  const cssUrl = `https://fonts.googleapis.com/css2?family=${family.css}&display=swap`;
  const cssRes = await fetch(cssUrl, { headers: { "User-Agent": UA } });
  if (!cssRes.ok) throw new Error(`css2 ${family.css} -> ${cssRes.status}`);
  const url = latinWoff2Url(await cssRes.text());

  const fontRes = await fetch(url, { headers: { "User-Agent": UA } });
  if (!fontRes.ok) throw new Error(`font ${url} -> ${fontRes.status}`);
  const bytes = Buffer.from(await fontRes.arrayBuffer());
  await writeFile(resolve(OUT, family.file), bytes);
  console.log(`${family.file}  ${(bytes.length / 1024).toFixed(1)} KB  <- ${url}`);
}

console.log(`\ndone -> ${OUT}`);
