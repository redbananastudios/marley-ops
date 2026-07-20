/**
 * Runs once after the whole suite. When the money specs ran against a staging
 * Zoho org, they raise real (staging) deposit/balance invoices the DB seed
 * doesn't track — so without cleanup a re-run accretes duplicates and eventually
 * approaches Zoho's list-page cap. Void + delete every E2E-prefixed invoice from
 * the staging org here.
 *
 * Guarded twice: it only runs when ZOHO_ORG_ID is a numeric staging org, and
 * `env()` inside purgeStagingInvoices independently refuses the live org id — so
 * this can never delete anything from Connor's live books.
 */
import { purgeStagingInvoices } from "./zoho";

export default async function globalTeardown() {
  if (!/^\d+$/.test(process.env.ZOHO_ORG_ID ?? "")) return; // no staging Zoho wired → nothing to clean
  try {
    const n = await purgeStagingInvoices("E2E-");
    if (n) console.log(`\n🧹 purged ${n} E2E invoice(s) from the staging Zoho org.\n`);
  } catch (err) {
    console.warn(`staging-invoice teardown skipped: ${err instanceof Error ? err.message : err}`);
  }
}
