import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The promotion runbook is the operator's script for a human-only, one-sitting
 * operation on live production. Nothing executes it, so the properties that
 * make it trustworthy have to be pinned by reading it — the same reason
 * seed-e2e's FK ordering is pinned from source rather than run.
 *
 * Three of these come from the second QA pass over the promotion payload:
 * a batch member with no verification query (a backfill that matched nothing
 * reads exactly like a correct no-op), a schema reload that lands after the
 * container it is supposed to protect, and a migration whose own header
 * promises a recovery path its statements cannot deliver.
 */
const ROOT = new URL("../../", import.meta.url);
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, ROOT)), "utf8");

const DOC = read("docs/pitmans-prod-migration-runbook.md");
const MIGRATIONS_DIR = fileURLToPath(new URL("supabase/migrations/", ROOT));

/** The files the order table actually tells a human to apply, in its own order. */
const orderedFiles = DOC.split("\n")
  .filter((line) => line.startsWith("|"))
  .flatMap((line) => [...line.matchAll(/supabase\/migrations\/(\d{4})_[a-z0-9_]+\.sql/g)])
  .map((m) => m[1]);

describe("promotion runbook", () => {
  it("lists every batch migration exactly once, and they all exist on disk", () => {
    expect(orderedFiles.length).toBeGreaterThan(0);
    expect(new Set(orderedFiles).size).toBe(orderedFiles.length);
    const onDisk = readdirSync(MIGRATIONS_DIR);
    for (const n of orderedFiles) {
      expect(onDisk.some((f) => f.startsWith(`${n}_`)), `no migration file for ${n}`).toBe(true);
    }
  });

  it("gives every applied migration a verification query", () => {
    // A migration with no verification block is indistinguishable on prod from
    // one that matched zero rows — and the only data-mutating file in the batch
    // was the one without a block.
    const verification = DOC.slice(DOC.indexOf("## Verification"));
    expect(verification.length).toBeGreaterThan(0);
    const missing = orderedFiles.filter((n) => !verification.includes(n));
    expect(missing, `migrations with no verification block: ${missing.join(", ")}`).toEqual([]);
  });

  it("reloads the PostgREST schema cache BEFORE the deploy row, not only after", () => {
    // The deploy's code names the batch's new columns in explicit select lists,
    // and PostgREST rejects a select naming a column its cached schema lacks —
    // which the fail-soft readers render as empty-and-healthy. The last files in
    // the pre-deploy block carry no reload of their own, so the runbook has to.
    const reload = DOC.indexOf("notify pgrst, 'reload schema';");
    const deploy = DOC.indexOf("DEPLOY THE CODE");
    expect(reload, "no reload statement in the runbook").toBeGreaterThan(-1);
    expect(deploy, "no deploy row in the order table").toBeGreaterThan(-1);
    expect(reload).toBeLessThan(deploy);
  });

  it("applies 0110 as a single transaction, because ADD CONSTRAINT is not re-runnable", () => {
    // 0110's header promises it is "safe to re-run after a failure". That is true
    // of its six sweeps and false of its `add constraint` statements (Postgres has
    // no ADD CONSTRAINT IF NOT EXISTS), and the prod recipe pipes the file into
    // psql with no --single-transaction, so every statement autocommits. The file
    // is applied history and cannot be edited; the runbook is what makes its
    // promise true.
    const section = DOC.slice(DOC.indexOf("### 0110 is the one migration"));
    expect(section.length).toBeGreaterThan(0);
    expect(section).toContain("--single-transaction");
  });
});

describe("crate minimum backfill", () => {
  const m0115 = read("supabase/migrations/0115_crate_calendar_month_minimum.sql");
  const corrections = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f > "0115_" && f.endsWith(".sql"))
    .map((f) => read(`supabase/migrations/${f}`))
    .filter((sql) => /set\s+min_kind\s*=\s*'days'/.test(sql));

  it("0115 keeps the v1-signature guard it shipped with", () => {
    // Applied to staging and queued for prod: a correction ships as a new file,
    // never as an edit to history.
    expect(m0115).toContain("terms_version like 'storage-terms-v1%'");
  });

  it("a later migration takes back the lets whose stamp 0115 could not read", () => {
    // Every storage signature taken before the first published storage terms
    // carries a retired constant or NULL, and `terms_version like '…v1%'` is
    // false/NULL for both — so 0115's guard flipped the very lets it names as
    // the ones to leave alone. The correction has to recognise a stamp by what
    // it IS, not by what it is not.
    expect(corrections, "no migration reverts min_kind to 'days'").toHaveLength(1);
    // Statements only — the file's comment quotes 0115's guard to explain it.
    const sql = corrections[0].replace(/^\s*--.*$/gm, "");
    expect(sql).toContain("terms_version is null");
    expect(sql).toContain("!~ '^storage-terms-v");
    expect(sql).not.toContain("like 'storage-terms-v1%'");
    // Only crate lets already flipped, so it can never disturb a container let
    // or one that was correctly left alone.
    expect(sql).toContain("min_kind = 'calendar_month'");
  });
});
