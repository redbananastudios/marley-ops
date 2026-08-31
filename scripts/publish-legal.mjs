/**
 * Distribute the published legal documents to the two places humans read them.
 *
 * The repo holds the immutable published text (see legal/README.md). This copies
 * it outward — it never reads anything back in, so neither destination can
 * become a competing source of truth:
 *
 *   Google Drive  Companies/MarleyMoves Ltd/06 Contracts & Legal/<Document>/
 *                 Published/<id>.html  — styled, printable, and importable into
 *                 Google Docs with formatting intact, which is what makes the
 *                 "draft in Drive, solicitor redlines, freeze to the repo"
 *                 workflow actually work. A PDF would be read-only and useless
 *                 for redlining.
 *                 Published/<id>.md    — the exact published source, for diffing
 *                 one version against the next.
 *
 *   Obsidian      01_Projects/Marley Moves/Legal/<document>.md — the version
 *                 history, what changed and why, and a read-only mirror of the
 *                 current text, so /recall can answer "when did we change the
 *                 cancellation clause" without becoming a fourth copy that
 *                 drifts.
 *
 * Usage:
 *   node scripts/publish-legal.mjs            # write
 *   node scripts/publish-legal.mjs --dry-run  # show what would be written
 */

import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LEGAL_DIR = join(ROOT, "legal");
const DRIVE = "F:/My Drive/Companies/MarleyMoves Ltd/06 Contracts & Legal";
const BRAIN = "O:/brain/01_Projects/Marley Moves/Legal";
const DRY = process.argv.includes("--dry-run");

const TITLE_FOLDER = { "customer-terms": "Customer Terms", "storage-terms": "Storage Terms" };

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Minimal markdown -> HTML. Same subset the PDF renderer handles. */
function mdToHtml(md) {
  const out = [];
  let inList = null;
  const inline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  const closeList = () => {
    if (inList) out.push(`</${inList}>`);
    inList = null;
  };
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("## ")) {
      closeList();
      out.push(`<h2>${inline(line.slice(3))}</h2>`);
    } else if (/^[-*]\s+/.test(line)) {
      if (inList !== "ul") {
        closeList();
        out.push("<ul>");
        inList = "ul";
      }
      out.push(`<li>${inline(line.replace(/^[-*]\s+/, ""))}</li>`);
    } else if (/^\d+\.\s+/.test(line)) {
      if (inList !== "ol") {
        closeList();
        out.push("<ol>");
        inList = "ol";
      }
      out.push(`<li>${inline(line.replace(/^\d+\.\s+/, ""))}</li>`);
    } else {
      closeList();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();
  return out.join("\n");
}

const htmlPage = (v, body) => `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8">
<title>${esc(v.title)} — ${esc(v.id)}</title>
<style>
 body{font-family:Georgia,'Times New Roman',serif;max-width:44em;margin:3em auto;padding:0 1.5em;color:#1f1d1b;line-height:1.6}
 h1{font-size:1.6em;margin-bottom:.1em} h2{font-size:1.15em;margin-top:1.8em;border-bottom:1px solid #e8e3dc;padding-bottom:.2em}
 .meta{color:#6f6a64;font-size:.85em;border:1px solid #e8e3dc;background:#fbf8f4;padding:1em 1.2em;border-radius:4px;margin:1.5em 0}
 .meta code{font-size:.9em;word-break:break-all} li{margin:.25em 0}
 @media print{body{margin:0;max-width:none}}
</style></head><body>
<h1>MarleyMoves Ltd — ${esc(v.title)}</h1>
<div class="meta">
 <strong>Version ${v.version}</strong> · id <code>${esc(v.id)}</code><br>
 Effective from ${v.effective_from}${v.effective_to ? ` until ${v.effective_to}` : " (current)"}<br>
 Approved by ${esc(v.approved_by)} on ${v.approved_at}<br>
 Fingerprint (SHA-256): <code>${v.sha256}</code><br>
 ${v.legal_review === "reviewed" ? "Reviewed by a solicitor." : "<strong>Not yet reviewed by a solicitor.</strong>"}
 <br><br><em>Published from the marley-ops repo (legal/${esc(v.document)}/). This copy is for reading and review. Edits here change nothing: a new version is created by adding a file in the repo.</em>
</div>
${body}
</body></html>
`;

/* ------------------------------------------------------------------- gather */

const manifest = JSON.parse(await readFile(join(LEGAL_DIR, "manifest.json"), "utf8"));
const bodies = new Map();
for (const folder of await readdir(LEGAL_DIR, { withFileTypes: true })) {
  if (!folder.isDirectory()) continue;
  for (const file of await readdir(join(LEGAL_DIR, folder.name))) {
    if (!file.endsWith(".md")) continue;
    const raw = await readFile(join(LEGAL_DIR, folder.name, file), "utf8");
    const m = /^---json\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n([\s\S]*)$/.exec(raw);
    if (m) bodies.set(JSON.parse(m[1]).id, { meta: JSON.parse(m[1]), body: m[2].replace(/\r\n/g, "\n").trim() });
  }
}

const write = async (path, contents) => {
  if (DRY) {
    console.log(`  would write ${path} (${contents.length} chars)`);
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
  console.log(`  ${path}`);
};

const driveReachable = existsSync("F:/My Drive");
if (!driveReachable) {
  // F: is the Google Drive mount and only exists while i9 is logged in
  // interactively. Say so rather than silently skipping half the job.
  console.warn("WARNING: F:/My Drive is not mounted — skipping the Drive copy. Log in interactively on i9 and re-run.");
}

/* ------------------------------------------------------------------ publish */

for (const [document, entry] of Object.entries(manifest.documents)) {
  const folder = TITLE_FOLDER[document] ?? document;
  console.log(`\n${document} (${entry.versions.length} version(s), current ${entry.current}):`);

  if (driveReachable) {
    for (const v of entry.versions) {
      const doc = bodies.get(v.id);
      if (!doc) continue;
      const full = { ...doc.meta, ...v };
      await write(`${DRIVE}/${folder}/Published/${v.id}.html`, htmlPage(full, mdToHtml(doc.body)));
      await write(`${DRIVE}/${folder}/Published/${v.id}.md`, doc.body + "\n");
    }
    await write(
      `${DRIVE}/${folder}/README.md`,
      `# ${entry.title}\n\n` +
        `**Published versions live in \`Published/\`. They are copies — the source of truth is the marley-ops repo (\`legal/${document}/\`).**\n\n` +
        `## How to change these terms\n\n` +
        `1. Draft here. Open the current \`.html\` in Google Docs (File > Open, formatting survives the import) and redline it, or start from the \`.md\`.\n` +
        `2. When it is agreed, it gets frozen into the repo as a NEW version file. Published versions are never edited: that is what lets us prove to a customer, an insurer or a court exactly which text they agreed to on the day they signed.\n` +
        `3. Publishing regenerates this folder, updates the website, and stamps the new version id onto every signature taken from then on.\n\n` +
        `## Current\n\n` +
        `\`${entry.current}\`${entry.versions.find((v) => v.id === entry.current)?.legal_review === "reviewed" ? "" : " — **not yet reviewed by a solicitor**"}\n\n` +
        `| Version | Effective | Fingerprint | Summary |\n|---|---|---|---|\n` +
        entry.versions
          .map(
            (v) =>
              `| ${v.version} | ${v.effective_from} to ${v.effective_to ?? "now"} | \`${v.sha256.slice(0, 12)}…\` | ${v.summary} |`,
          )
          .join("\n") +
        "\n",
    );
  }

  // Brain: history + narrative + a clearly-labelled mirror of the current text.
  const current = bodies.get(entry.current);
  await write(
    `${BRAIN}/${entry.title}.md`,
    `---\ntags: [marley, legal, terms]\n---\n\n# ${entry.title}\n\n` +
      `Source of truth: \`marley-ops/legal/${document}/\`. Human/review copies: Google Drive ` +
      `\`Companies/MarleyMoves Ltd/06 Contracts & Legal/${folder}/\`. ` +
      `Every signature stores the version id, the text, and its SHA-256 (migration 0093), so a signature proves itself without depending on any of these copies surviving.\n\n` +
      `## Versions\n\n| Version | Effective | Reviewed | Summary |\n|---|---|---|---|\n` +
      entry.versions
        .map(
          (v) =>
            `| \`${v.id}\` | ${v.effective_from} to ${v.effective_to ?? "**now**"} | ${v.legal_review === "reviewed" ? "yes" : "no"} | ${v.summary} |`,
        )
        .join("\n") +
      `\n\n## Current text (mirror — generated, do not edit)\n\n` +
      `> Editing this note changes nothing. To change the terms, add a new version file in the repo and re-run \`node scripts/publish-legal.mjs\`.\n\n` +
      (current?.body ?? "") +
      "\n",
  );
}

/* --------------------------------------------------------------- website */

/**
 * The site repo gets the CURRENT version of each document as a generated TS
 * module, so the public terms page and the app serve one artifact and can never
 * disagree again — the drift that put "fully refundable up to 48 hours" on the
 * website while the app enforced a 25% commitment.
 *
 * A generated module rather than a file read for the same reason as marley-ops:
 * bundling is guaranteed, file tracing is not. A copy rather than a fetch,
 * because a site build that calls an ops API puts a live dependency in the
 * release path — the failure class that took a deploy down this morning.
 */
const SITE_ROOT = process.env.MARLEY_SITE_ROOT
  ? resolve(process.env.MARLEY_SITE_ROOT)
  : resolve(ROOT, "..", "site");
const SITE_LIB = resolve(SITE_ROOT, "web", "lib", "legal");
if (existsSync(resolve(SITE_ROOT, "web"))) {
  const current = Object.entries(manifest.documents).map(([document, entry]) => {
    const v = entry.versions.find((x) => x.id === entry.current);
    const doc = bodies.get(entry.current);
    return {
      document,
      title: entry.title,
      id: v.id,
      version: v.version,
      effective_from: v.effective_from,
      sha256: v.sha256,
      legal_review: v.legal_review,
      body: doc?.body ?? "",
    };
  });

  console.log("\nwebsite:");
  await write(
    join(SITE_LIB, "generated.ts"),
    `// GENERATED by marley-ops/scripts/publish-legal.mjs — do not edit.\n` +
      `//\n` +
      `// The CURRENT published version of each legal document. The source of truth\n` +
      `// is marley-ops/legal/; this is a copy so the site and the ops app render the\n` +
      `// same text. If you need to change the terms, change them there and re-run\n` +
      `// the publish script — editing this file changes what the website shows\n` +
      `// without changing what customers are recorded as having agreed to.\n\n` +
      `export interface PublishedLegalDocument {\n` +
      `  document: string;\n  title: string;\n  id: string;\n  version: number;\n` +
      `  effective_from: string;\n  sha256: string;\n  legal_review: string;\n  body: string;\n}\n\n` +
      `export const PUBLISHED_LEGAL: PublishedLegalDocument[] = ${JSON.stringify(current, null, 2)};\n\n` +
      `export const legalDoc = (document: string): PublishedLegalDocument | undefined =>\n` +
      `  PUBLISHED_LEGAL.find((d) => d.document === document);\n`,
  );
} else {
  console.warn("\nWARNING: site repo not found next to marley-ops — skipping the website copy.");
}

console.log(DRY ? "\ndry run — nothing written" : "\npublished");
