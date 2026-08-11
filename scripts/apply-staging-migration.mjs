/**
 * Apply a migration to the STAGING Supabase project, per docs/ovh-deployment.md:
 * session pooler, node `pg`, wrapped in a transaction, rolled back on any error.
 *
 * The runbook described this connection in prose and every migration re-derived
 * it by hand. Doing that with psql through an ssh hop mangles the password
 * (it contains a `!`), which reads as "password authentication failed" and sends
 * you looking for the wrong problem. So it lives in a script.
 *
 *   node scripts/apply-staging-migration.mjs supabase/migrations/0093_x.sql
 *   node scripts/apply-staging-migration.mjs <file> --verify "select …"
 *
 * Reads MARLEY_STAGING_SUPABASE_DB_PASSWORD from the environment, or falls back
 * to the canonical credentials file. Never hardcode it.
 */

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Client } = require("pg");

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/apply-staging-migration.mjs <migration.sql> [--verify \"sql\"]");
  process.exit(1);
}
const verifyIdx = process.argv.indexOf("--verify");
const verifySql = verifyIdx > 0 ? process.argv[verifyIdx + 1] : null;

async function password() {
  if (process.env.MARLEY_STAGING_SUPABASE_DB_PASSWORD) {
    return process.env.MARLEY_STAGING_SUPABASE_DB_PASSWORD;
  }
  const creds = await readFile("F:/My Drive/workspace/credentials.env", "utf8");
  const line = creds.split(/\r?\n/).find((l) => l.startsWith("MARLEY_STAGING_SUPABASE_DB_PASSWORD="));
  if (!line) throw new Error("MARLEY_STAGING_SUPABASE_DB_PASSWORD not found in credentials.env");
  return line.slice(line.indexOf("=") + 1).replace(/^"|"$/g, "").trim();
}

const sql = await readFile(file, "utf8");
const client = new Client({
  host: "aws-0-eu-west-1.pooler.supabase.com",
  port: 5432,
  user: "postgres.nrghwyfakrgobcczuuca",
  database: "postgres",
  password: await password(),
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 30_000,
});

await client.connect();
console.log(`connected to staging — applying ${file}`);

try {
  await client.query("begin");
  await client.query(sql);
  await client.query("commit");
  console.log("applied + committed");
} catch (error) {
  await client.query("rollback").catch(() => {});
  console.error("ROLLED BACK:", error.message);
  await client.end();
  process.exit(1);
}

if (verifySql) {
  const { rows } = await client.query(verifySql);
  console.log("verify:");
  console.table(rows);
}

await client.end();
