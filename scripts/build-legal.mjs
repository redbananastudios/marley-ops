/**
 * Compile the published legal documents in `legal/` into artifacts the app and
 * the website can use, and verify they have not been tampered with.
 *
 * Outputs:
 *   legal/manifest.json      — id -> body SHA-256, paths, effective dates, which
 *                              version is current. Generated; never hand-edited.
 *   lib/legal/generated.ts   — the same data PLUS the body text, as a bundled TS
 *                              module.
 *
 * Why a generated module rather than reading the markdown at runtime: next.config
 * sets `output: "standalone"` and the Dockerfile copies only `.next` and `public`
 * into the runner. Loose files under `legal/` would simply not exist in
 * production, and the failure would appear the first time a customer signed.
 *
 * Frontmatter is a JSON block (`---json … ---`) rather than YAML because there is
 * no YAML parser in this project's dependencies, and adding one to parse a
 * document whose whole purpose is to be unambiguous felt like the wrong trade.
 *
 * Usage:
 *   node scripts/build-legal.mjs            # write the artifacts
 *   node scripts/build-legal.mjs --check    # fail if they are stale or invalid
 *
 * --check runs in the gates, so a published file edited in place, a hash that no
 * longer matches, or a forgotten rebuild all fail the build rather than silently
 * changing what we claim a customer agreed to.
 */

import { createHash } from "node:crypto";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LEGAL_DIR = join(ROOT, "legal");
const MANIFEST_PATH = join(LEGAL_DIR, "manifest.json");
const GENERATED_PATH = join(ROOT, "lib", "legal", "generated.ts");
const CHECK = process.argv.includes("--check");

const fail = (msg) => {
  console.error(`legal: ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
};

/** Split `---json … ---` frontmatter from the body. */
function parseDocument(raw, relPath) {
  const match = /^---json\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n([\s\S]*)$/.exec(raw);
  if (!match) fail(`${relPath}: missing ---json frontmatter block`);
  let meta;
  try {
    meta = JSON.parse(match[1]);
  } catch (error) {
    fail(`${relPath}: frontmatter is not valid JSON (${error.message})`);
  }
  // Normalise line endings before hashing: a checkout with autocrlf must not
  // produce a different hash from the one recorded against a signature.
  const body = match[2].replace(/\r\n/g, "\n").trim();
  return { meta, body };
}

const REQUIRED = ["id", "document", "title", "version", "effective_from", "approved_by", "summary"];

function validate(meta, body, relPath) {
  for (const key of REQUIRED) {
    if (meta[key] === undefined || meta[key] === null || meta[key] === "") {
      fail(`${relPath}: frontmatter is missing "${key}"`);
    }
  }
  if (!body) fail(`${relPath}: document body is empty`);
  const expectedId = `${meta.document}-v${meta.version}-${meta.effective_from}`;
  if (meta.id !== expectedId) {
    fail(`${relPath}: id "${meta.id}" should be "${expectedId}" (document-vN-effective_from)`);
  }
  if (!Array.isArray(meta.acknowledgments)) {
    fail(`${relPath}: acknowledgments must be an array (use [] if the document has none)`);
  }
  for (const ack of meta.acknowledgments) {
    if (!ack || typeof ack.key !== "string" || typeof ack.label !== "string") {
      fail(`${relPath}: each acknowledgment needs a string key and label`);
    }
  }
}

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/* ------------------------------------------------------------------ collect */

const documents = [];
let folders;
try {
  folders = (await readdir(LEGAL_DIR, { withFileTypes: true })).filter((d) => d.isDirectory());
} catch {
  fail(`no legal/ directory at ${LEGAL_DIR}`);
}

for (const folder of folders) {
  const files = (await readdir(join(LEGAL_DIR, folder.name))).filter((f) => f.endsWith(".md")).sort();
  for (const file of files) {
    const relPath = `legal/${folder.name}/${file}`;
    const raw = await readFile(join(LEGAL_DIR, folder.name, file), "utf8");
    const { meta, body } = parseDocument(raw, relPath);
    validate(meta, body, relPath);
    if (meta.document !== folder.name) {
      fail(`${relPath}: document "${meta.document}" does not match its folder "${folder.name}"`);
    }
    documents.push({ ...meta, path: relPath, body, sha256: sha256(body) });
  }
}

if (documents.length === 0) fail("no published documents found");

/* ----------------------------------------------------------------- validate */

const byDocument = new Map();
for (const doc of documents) {
  if (!byDocument.has(doc.document)) byDocument.set(doc.document, []);
  byDocument.get(doc.document).push(doc);
}

const seenIds = new Set();
for (const doc of documents) {
  if (seenIds.has(doc.id)) fail(`duplicate id "${doc.id}"`);
  seenIds.add(doc.id);
}

for (const [name, versions] of byDocument) {
  versions.sort((a, b) => a.version - b.version);

  const current = versions.filter((v) => !v.effective_to);
  if (current.length !== 1) {
    fail(`${name}: exactly one version must be current (effective_to null), found ${current.length}`);
  }
  if (current[0].version !== versions[versions.length - 1].version) {
    fail(`${name}: the current version must be the highest-numbered one`);
  }

  versions.forEach((v, i) => {
    if (v.version !== i + 1) fail(`${name}: versions must run 1..N with no gaps (found v${v.version} at position ${i + 1})`);
    const previous = versions[i - 1];
    if (i === 0) {
      if (v.supersedes) fail(`${name}: v1 cannot supersede anything`);
    } else {
      if (v.supersedes !== previous.id) fail(`${name}: ${v.id} should supersede ${previous.id}`);
      // A gap or an overlap means there is a moment we cannot answer "which
      // terms were live?" — the exact question this system exists to answer.
      if (previous.effective_to !== v.effective_from) {
        fail(`${name}: ${previous.id} ends ${previous.effective_to} but ${v.id} starts ${v.effective_from} — no gaps or overlaps`);
      }
    }
  });
}

/* -------------------------------------------------------------------- emit */

const manifest = {
  generated_by: "scripts/build-legal.mjs",
  documents: Object.fromEntries(
    [...byDocument].map(([name, versions]) => [
      name,
      {
        title: versions[0].title,
        current: versions.find((v) => !v.effective_to).id,
        versions: versions.map((v) => ({
          id: v.id,
          version: v.version,
          path: v.path,
          sha256: v.sha256,
          effective_from: v.effective_from,
          effective_to: v.effective_to ?? null,
          summary: v.summary,
          legal_review: v.legal_review ?? "pending",
        })),
      },
    ]),
  ),
};

const generated = `// GENERATED by scripts/build-legal.mjs — do not edit.
// Run \`node scripts/build-legal.mjs\` after changing anything in legal/.
//
// The published legal documents are compiled into this module because
// next.config uses output: "standalone" and the Docker runner copies only
// .next and public — loose markdown under legal/ does not exist in production.

export interface LegalAcknowledgment {
  key: string;
  label: string;
}

export interface LegalVersion {
  id: string;
  document: string;
  title: string;
  version: number;
  effective_from: string;
  effective_to: string | null;
  supersedes: string | null;
  summary: string;
  legal_review: "pending" | "reviewed";
  acknowledgments: LegalAcknowledgment[];
  /** SHA-256 of \`body\`, stamped against every signature. */
  sha256: string;
  body: string;
}

export const LEGAL_VERSIONS: LegalVersion[] = ${JSON.stringify(
  documents.map((d) => ({
    id: d.id,
    document: d.document,
    title: d.title,
    version: d.version,
    effective_from: d.effective_from,
    effective_to: d.effective_to ?? null,
    supersedes: d.supersedes ?? null,
    summary: d.summary,
    legal_review: d.legal_review ?? "pending",
    acknowledgments: d.acknowledgments,
    sha256: d.sha256,
    body: d.body,
  })),
  null,
  2,
)};
`;

const previousManifest = await readFile(MANIFEST_PATH, "utf8").catch(() => null);
const previousGenerated = await readFile(GENERATED_PATH, "utf8").catch(() => null);
const nextManifest = `${JSON.stringify(manifest, null, 2)}\n`;

const norm = (s) => (s === null ? null : s.replace(/\r\n/g, "\n"));
const stale =
  norm(previousManifest) !== norm(nextManifest) || norm(previousGenerated) !== norm(generated);

if (CHECK) {
  if (stale) {
    fail("legal artifacts are stale — run `node scripts/build-legal.mjs` and commit the result");
  }
  console.log(`legal: ok — ${documents.length} published version(s) across ${byDocument.size} document(s)`);
} else {
  await mkdir(dirname(GENERATED_PATH), { recursive: true });
  await writeFile(MANIFEST_PATH, nextManifest, "utf8");
  await writeFile(GENERATED_PATH, generated, "utf8");
  for (const [name, versions] of byDocument) {
    const current = versions.find((v) => !v.effective_to);
    console.log(`${name}: ${versions.length} version(s), current ${current.id} (${current.sha256.slice(0, 12)}…)`);
  }
}
