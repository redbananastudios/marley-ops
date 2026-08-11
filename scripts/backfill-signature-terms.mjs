/**
 * Backfill terms evidence onto signatures taken before 0093.
 *
 * The point is to be TRUTHFUL rather than convenient: each signature is mapped
 * to the version that was live on the UK day it was signed, not to whatever is
 * current now. Stamping today's terms onto a July signature would manufacture
 * evidence, which is worse than having none.
 *
 * We can do this honestly because the site's terms page was unchanged from
 * 2026-06-16 (commit 8d01497) until 2026-08-11, and every existing signature
 * falls inside that window — so customer-terms v1 is what they were served, and
 * v1 is a verbatim reconstruction of that commit.
 *
 * Idempotent: only fills rows where terms_snapshot is null. Dry-run by default.
 *
 *   node scripts/backfill-signature-terms.mjs --versions versions.json
 *   node scripts/backfill-signature-terms.mjs --versions versions.json --apply
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createClient } = require("@supabase/supabase-js");

const APPLY = process.argv.includes("--apply");
const vIdx = process.argv.indexOf("--versions");
if (vIdx < 0) {
  console.error("usage: node scripts/backfill-signature-terms.mjs --versions <versions.json> [--apply]");
  process.exit(1);
}

const versions = JSON.parse(await readFile(process.argv[vIdx + 1], "utf8"));

// Verify the payload before touching a single row: if a body no longer hashes
// to its recorded digest, the archive is not trustworthy and neither would the
// backfill be.
for (const v of versions) {
  const actual = createHash("sha256").update(v.body, "utf8").digest("hex");
  if (actual !== v.sha256) {
    console.error(`ABORT: ${v.id} body does not match its recorded hash`);
    process.exit(1);
  }
}
console.log(`payload verified: ${versions.length} published version(s)`);

const ukDay = (iso) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(iso));

const effectiveOn = (document, day) =>
  versions
    .filter((v) => v.document === document)
    .sort((a, b) => a.version - b.version)
    .find((v) => v.effective_from <= day && (v.effective_to === null || day < v.effective_to)) ?? null;

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const { data: rows, error } = await sb
  .from("signatures")
  .select("id, kind, signer_name, signed_at, terms_version, terms_snapshot")
  .is("terms_snapshot", null)
  .order("signed_at");
if (error) {
  console.error("query failed:", error.message);
  process.exit(1);
}

console.log(APPLY ? "*** APPLYING ***" : "--- DRY RUN (add --apply to write) ---");
console.log(`${rows?.length ?? 0} signature(s) without terms evidence\n`);

let filled = 0;
let unmapped = 0;

for (const row of rows ?? []) {
  const document = row.kind === "storage" ? "storage-terms" : "customer-terms";
  const day = ukDay(row.signed_at);
  const version = effectiveOn(document, day);

  if (!version) {
    // Never guess. A signature taken before anything was published is a real
    // gap and should be visible as one.
    console.log(`  SKIP  ${day}  ${row.kind.padEnd(12)} ${row.signer_name} — no ${document} version was live that day (was: ${row.terms_version})`);
    unmapped++;
    continue;
  }

  console.log(`  ${APPLY ? "SET " : "would"} ${day}  ${row.kind.padEnd(12)} ${row.signer_name} -> ${version.id}${row.terms_version && row.terms_version !== version.id ? `  (replacing "${row.terms_version}")` : ""}`);

  if (APPLY) {
    const { error: updateError } = await sb
      .from("signatures")
      .update({
        terms_version: version.id,
        terms_sha256: version.sha256,
        terms_snapshot: version.body,
        acknowledgment_labels: Object.fromEntries(version.acknowledgments.map((a) => [a.key, a.label])),
      })
      .eq("id", row.id)
      .is("terms_snapshot", null); // CAS: never overwrite evidence already captured
    if (updateError) {
      console.error(`    FAILED: ${updateError.message}`);
      process.exitCode = 1;
      continue;
    }
  }
  filled++;
}

console.log(`\n${APPLY ? "filled" : "would fill"}: ${filled}   unmapped: ${unmapped}`);
