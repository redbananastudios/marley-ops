/**
 * Runs once before the whole suite. Its only job is a hard safety gate: the E2E
 * suite creates records and drives sandbox payments, so it must NEVER touch
 * production. If E2E_BASE_URL looks like prod, refuse to run.
 */
export default async function globalSetup() {
  const base = process.env.E2E_BASE_URL || "http://localhost:3015";
  const host = (() => {
    try {
      return new URL(base).host;
    } catch {
      return base;
    }
  })();

  // EXACT host match, not substring: `staging.ops.marleymoves.co.uk` contains
  // the prod host as a substring, so `.includes()` would wrongly refuse staging.
  const PROD_HOSTS = ["ops.marleymoves.co.uk", "www.ops.marleymoves.co.uk"];
  if (PROD_HOSTS.some((h) => host === h)) {
    throw new Error(
      `E2E refuses to run against a production host (${host}). Point E2E_BASE_URL at staging or local dev.`,
    );
  }

  console.log(`\n▶ E2E target: ${base}\n`);
}
