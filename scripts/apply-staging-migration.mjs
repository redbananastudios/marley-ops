/**
 * Apply one migration to the STAGING Supabase project, in a transaction, with
 * the target table's shape printed before and after.
 *
 * Staging first, then prod, and always BEFORE the deploy that needs the column
 * (docs/ovh-deployment.md). Rolls back on any error rather than leaving a
 * half-applied schema.
 *
 *   node scripts/apply-staging-migration.mjs supabase/migrations/00NN_x.sql [table]
 */
import { readFileSync } from "node:fs";
import pg from "pg";

const [, , file, table = "business_settings"] = process.argv;
if (!file) {
  console.error("usage: node scripts/apply-staging-migration.mjs <migration.sql> [table]");
  process.exit(1);
}

const password = process.env.MARLEY_STAGING_SUPABASE_DB_PASSWORD;
if (!password) {
  console.error("MARLEY_STAGING_SUPABASE_DB_PASSWORD is not set — source credentials.env first.");
  process.exit(1);
}

const sql = readFileSync(file, "utf8");
const client = new pg.Client({
  host: "aws-0-eu-west-1.pooler.supabase.com",
  port: 5432,
  user: "postgres.nrghwyfakrgobcczuuca",
  database: "postgres",
  password,
  ssl: { rejectUnauthorized: false },
});

const columns = async () => {
  const { rows } = await client.query(
    `select column_name, data_type, is_nullable, column_default
       from information_schema.columns
      where table_name = $1
      order by ordinal_position`,
    [table],
  );
  return rows;
};

await client.connect();
try {
  const before = await columns();
  console.log(`BEFORE: ${table} has ${before.length} columns`);

  await client.query("begin");
  await client.query(sql);
  await client.query("commit");

  const after = await columns();
  console.log(`AFTER:  ${table} has ${after.length} columns`);
  const beforeNames = new Set(before.map((c) => c.column_name));
  const added = after.filter((c) => !beforeNames.has(c.column_name));
  for (const c of added) {
    console.log(`  + ${c.column_name} ${c.data_type} nullable=${c.is_nullable} default=${c.column_default}`);
  }
  if (added.length === 0) console.log("  (no new columns — already applied?)");
  console.log("APPLIED OK");
} catch (err) {
  await client.query("rollback").catch(() => {});
  console.error("FAILED, rolled back:", err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
