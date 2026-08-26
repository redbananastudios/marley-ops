#!/usr/bin/env node
/**
 * Snapshot the outgoing ledger's invoices into `ledger_invoice_archive`
 * (docs/ledger-adapter-design.md §9, PRD §3.4, gate 17).
 *
 * ## Why this exists, sharpened by what the Xero migration actually did
 *
 * Only ONE render-time surface reads the ledger live: /finance. Every
 * lead-history surface already reads denormalised `quotes.zoho_*` columns from
 * our own DB, so lead history survives the flip with or without this table.
 *
 * The original argument for the archive was "keep /finance's view of invoices
 * raised by hand in the books after the Zoho account lapses". Peter's Xero
 * invoice list (2026-08-26) made it sharper: the migrated invoices in Xero read
 * `Awaiting Payment` with `Paid 0.00` across the board. If the payment history
 * genuinely did not migrate, then after the flip Xero is authoritative for the
 * DOCUMENTS but has no idea which of them were settled — and this archive is the
 * only record left of what was actually paid. Run it BEFORE the flip, and run it
 * again before the Zoho account lapses if those are different days.
 *
 * ## Usage — DRY RUN is the default, nothing is written until --commit
 *
 *   node scripts/ledger-snapshot.mjs                      # plan only
 *   node scripts/ledger-snapshot.mjs --commit             # write (staging)
 *   node scripts/ledger-snapshot.mjs --commit --prod      # write (prod needs the extra flag)
 *   node scripts/ledger-snapshot.mjs --since 2026-01-01   # optional window
 *
 * Re-runnable: rows upsert on (provider, external_id), so a second pass
 * refreshes statuses and balances rather than duplicating. That is deliberate —
 * the useful snapshot is the LAST one taken before the flip.
 *
 * Env: the same `ZOHO_*` pair the app uses, plus NEXT_PUBLIC_SUPABASE_URL and
 * SUPABASE_SERVICE_ROLE_KEY. Run with `node --env-file=<envfile>`, or via the
 * docker `--env-file /opt/marley-ops[-staging]/app.env` pattern on the VPS.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const PROVIDER = "zoho";

/* ------------------------------------------------------------------ args */

function parseArgs(argv = process.argv.slice(2)) {
  const has = (f) => argv.includes(f);
  const val = (f) => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return { COMMIT: has("--commit"), PROD: has("--prod"), SINCE: val("--since"), UNTIL: val("--until") };
}

/* ------------------------------------------------------------------ zoho */

const ZOHO_TIMEOUT_MS = 20_000;
/**
 * Hard page cap. Unlike the app's `listInvoices`, which returns a `truncated`
 * flag and lets the caller decide, hitting this cap here is a FAILURE: a partial
 * archive that reports success is exactly the "I could not check rendering as
 * nothing to report" shape. Raise it and re-run rather than accepting the cut.
 */
const MAX_PAGES = 200;
const PER_PAGE = 200;

function zohoCfg() {
  const c = {
    clientId: process.env.ZOHO_CLIENT_ID,
    clientSecret: process.env.ZOHO_CLIENT_SECRET,
    refreshToken: process.env.ZOHO_REFRESH_TOKEN,
    orgId: process.env.ZOHO_ORG_ID,
    accountsUrl: process.env.ZOHO_ACCOUNTS_URL || "https://accounts.zoho.eu",
    apiUrl: process.env.ZOHO_API_URL || "https://www.zohoapis.eu",
  };
  const missing = ["clientId", "clientSecret", "refreshToken", "orgId"].filter((k) => !c[k]);
  if (missing.length) {
    fail(`Zoho credentials not configured — missing ZOHO_${missing.map(envName).join(", ZOHO_")}`);
  }
  return c;
}
const envName = (k) =>
  ({ clientId: "CLIENT_ID", clientSecret: "CLIENT_SECRET", refreshToken: "REFRESH_TOKEN", orgId: "ORG_ID" })[k];

let accessToken = null;
async function token(c) {
  if (accessToken) return accessToken;
  const res = await fetch(`${c.accountsUrl}/oauth/v2/token`, {
    method: "POST",
    signal: AbortSignal.timeout(ZOHO_TIMEOUT_MS),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: c.refreshToken,
      client_id: c.clientId,
      client_secret: c.clientSecret,
      grant_type: "refresh_token",
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) fail(`Zoho token refresh failed: ${json.error ?? res.status}`);
  accessToken = json.access_token;
  return accessToken;
}

async function zohoGet(c, path) {
  const res = await fetch(`${c.apiUrl}/invoice/v3${path}`, {
    signal: AbortSignal.timeout(ZOHO_TIMEOUT_MS),
    headers: {
      Authorization: `Zoho-oauthtoken ${await token(c)}`,
      "X-com-zoho-invoice-organizationid": c.orgId,
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || (typeof json.code === "number" && json.code !== 0)) {
    fail(`Zoho GET ${path} failed: ${json.message ?? res.status}`);
  }
  return json;
}

/** Frozen at capture. Reconstructing this later is impossible — the constructor
 *  reads ZOHO_ORG_ID, which is removed from app.env at decommission, after which
 *  every rebuilt link silently points at a broken page while still looking fine. */
const appUrl = (orgId, invoiceId) => `https://invoice.zoho.eu/app/${orgId}#/invoices/${invoiceId}`;

/* ----------------------------------------------------------- attribution */

/**
 * Brand from OUR reference, mirroring the bank-feed matcher's patterns
 * (`lib/bank-feed/match.ts` REF_PATTERNS) rather than a `startsWith(ref_prefix)`
 * compare.
 *
 * The prefix compare looks right and is wrong: storage references are
 * `MMS-<hash>` minted with no brand input at all (`lib/storage-billing.ts`), so
 * a prefix test attributes EVERY storage invoice — Pitmans lets included — to
 * Marley. Both patterns below require a brand-bearing shape.
 *
 * Unlike the matcher, this reads `brands.ref_prefix` from the DB: the matcher is
 * pure/sync and cannot, a script can, and the table is the source of truth.
 *
 * Returns null when there is no confident match. Ambiguity yields nothing.
 */
export function brandFromReference(reference, prefixToBrand) {
  const hay = (reference ?? "").toUpperCase();
  // Current scheme: MMR001 / MMC014 / PMR001 — brand letter pair + R|C + digits.
  const current = hay.match(/\b(MM|PM)[RC]\d{3,}/);
  if (current) return prefixToBrand.get(current[1]) ?? null;
  // Legacy scheme: MM-YYMMDD-NNN. Carries the brand pair but no R|C kind.
  const legacy = hay.match(/\b(MM|PM)-\d{6}-\d{3}/);
  if (legacy) return prefixToBrand.get(legacy[1]) ?? null;
  // Anything else — iMVE imports (IMV007-BAL), storage (MMS-…), hand-typed refs.
  return null;
}

/* ------------------------------------------------------------------ main */

function fail(msg) {
  console.error(`\nFAILED: ${msg}\n`);
  process.exit(1);
}

/** Built lazily: an IIFE here would `process.exit` on IMPORT, which kills the
 *  vitest twin that exercises `brandFromReference` with no env at all. */
function supabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) fail("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  return createClient(url, key, { auth: { persistSession: false } });
}

async function main() {
  const { COMMIT, PROD, SINCE, UNTIL } = parseArgs();
  const sb = supabase();
  const c = zohoCfg();
  const sbHost = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host;
  /**
   * Staging is a HOSTED supabase.co project; production is the self-hosted stack
   * on the OVH box. That is a structural difference, not a naming convention —
   * `scripts/import-imve.mjs` uses the same test for the same reason. Do NOT
   * substitute a /staging/ hostname match: staging's project ref is an opaque
   * hash (`nrghwyfakrgobcczuuca.supabase.co`) with no such word in it, so a name
   * test both false-alarms on staging AND fails to warn on a host that happens
   * to contain the word.
   */
  const looksHosted = /\.supabase\.co$/i.test(sbHost);

  console.log("");
  console.log("  ledger snapshot");
  console.log(`  provider   ${PROVIDER}  (org ${c.orgId})`);
  console.log(`  target     ${sbHost}   (${looksHosted ? "hosted — staging" : "SELF-HOSTED — production?"})`);
  console.log(`  window     ${SINCE ?? "(all time)"} -> ${UNTIL ?? "(today)"}`);
  console.log(`  mode       ${COMMIT ? "COMMIT" : "DRY RUN — nothing will be written"}`);
  console.log("");

  if (COMMIT && !looksHosted && !PROD) {
    fail(`${sbHost} is NOT the hosted staging project — pass --prod if you really mean production.`);
  }

  // brands.ref_prefix is the source of truth for attribution.
  const { data: brands, error: brandErr } = await sb.from("brands").select("slug, ref_prefix");
  if (brandErr) fail(`Could not read brands: ${brandErr.message}`);
  const prefixToBrand = new Map(
    (brands ?? []).filter((b) => b.ref_prefix).map((b) => [String(b.ref_prefix).toUpperCase(), b.slug]),
  );
  console.log(`  prefixes   ${[...prefixToBrand].map(([p, b]) => `${p}->${b}`).join("  ") || "(none)"}`);

  /* ---- page every invoice ---- */

  const rows = [];
  let page = 1;
  for (; page <= MAX_PAGES; page++) {
    const params = new URLSearchParams({
      page: String(page),
      per_page: String(PER_PAGE),
      sort_column: "date",
      sort_order: "D",
    });
    if (SINCE) params.set("date_start", SINCE);
    if (UNTIL) params.set("date_end", UNTIL);
    const res = await zohoGet(c, `/invoices?${params.toString()}`);
    for (const i of res.invoices ?? []) {
      const reference = i.reference_number ?? "";
      rows.push({
        provider: PROVIDER,
        external_id: i.invoice_id,
        invoice_number: i.invoice_number ?? "",
        reference,
        customer_name: i.customer_name ?? "",
        invoice_date: i.date || null,
        status: i.status ?? "",
        total: Number(i.total ?? 0),
        balance: Number(i.balance ?? 0),
        // Audit only, never rendered — /finance derives VAT app-side, and a
        // second stored figure beside live rows on the same page would diverge.
        // Zoho's LIST rows do not always carry it; null is recorded honestly and
        // counted below rather than back-filled with a guess.
        provider_tax_total: i.tax_total != null ? Number(i.tax_total) : null,
        app_url: appUrl(c.orgId, i.invoice_id),
        brand: brandFromReference(reference, prefixToBrand),
      });
    }
    process.stdout.write(`\r  fetched    ${rows.length} invoices (page ${page})   `);
    if (!res.page_context?.has_more_page) break;
  }
  console.log("");
  if (page > MAX_PAGES) {
    fail(
      `hit the ${MAX_PAGES}-page cap with more pages remaining — this snapshot would be INCOMPLETE. ` +
        `Raise MAX_PAGES and re-run. A partial archive that reports success is worse than no archive.`,
    );
  }

  /* ---- report ---- */

  const byBrand = new Map();
  for (const r of rows) byBrand.set(r.brand ?? "(unattributed)", (byBrand.get(r.brand ?? "(unattributed)") ?? 0) + 1);
  const byStatus = new Map();
  for (const r of rows) byStatus.set(r.status || "(blank)", (byStatus.get(r.status || "(blank)") ?? 0) + 1);
  const noTax = rows.filter((r) => r.provider_tax_total == null).length;
  const gross = rows.reduce((a, r) => a + r.total, 0);
  const outstanding = rows.reduce((a, r) => a + r.balance, 0);

  console.log("");
  console.log(`  invoices   ${rows.length}`);
  console.log(`  gross      £${gross.toFixed(2)}     outstanding £${outstanding.toFixed(2)}`);
  console.log(`  by status  ${[...byStatus].map(([s, n]) => `${s}=${n}`).join("  ")}`);
  console.log(`  by brand   ${[...byBrand].map(([b, n]) => `${b}=${n}`).join("  ")}`);
  console.log(
    `  tax_total  ${rows.length - noTax} captured, ${noTax} null` +
      (noTax ? "  (audit column only — null here is recorded, not inferred)" : ""),
  );
  console.log("");

  if (!rows.length) {
    // An empty result and an unreachable source are different answers, and this
    // one is genuinely suspicious: a live org with no invoices means the window
    // or the org id is wrong, not that the books are empty.
    fail("Zoho returned ZERO invoices. That is almost certainly the wrong org id or window, not an empty ledger.");
  }

  if (!COMMIT) {
    console.log("  DRY RUN — re-run with --commit to write. Sample of what would be stored:");
    for (const r of rows.slice(0, 5)) {
      console.log(
        `    ${(r.invoice_number || "?").padEnd(12)} ${(r.reference || "-").padEnd(20)} ` +
          `${r.status.padEnd(15)} £${r.total.toFixed(2).padStart(9)} bal £${r.balance.toFixed(2).padStart(9)} ` +
          `brand=${r.brand ?? "null"}`,
      );
    }
    console.log("");
    return;
  }

  /* ---- write ---- */

  const CHUNK = 200;
  let written = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const { error } = await sb
      .from("ledger_invoice_archive")
      .upsert(slice, { onConflict: "provider,external_id" });
    if (error) fail(`upsert failed at row ${i}: ${error.message}`);
    written += slice.length;
    process.stdout.write(`\r  written    ${written}/${rows.length}   `);
  }
  console.log("");

  /* ---- verify by reading back, not by trusting the writes ---- */

  const { count, error: countErr } = await sb
    .from("ledger_invoice_archive")
    .select("*", { count: "exact", head: true })
    .eq("provider", PROVIDER);
  if (countErr) fail(`could not verify: ${countErr.message}`);
  console.log(`  verified   ${count} rows now in ledger_invoice_archive for provider=${PROVIDER}`);
  if ((count ?? 0) < rows.length) {
    fail(`read-back shows ${count} rows but ${rows.length} were sent. Do NOT treat this archive as complete.`);
  }
  console.log("");
}

/* Only run when invoked as a script — importing this module (the vitest twin
 * does, for `brandFromReference`) must not touch Zoho, Supabase or argv. Same
 * guard shape as scripts/brand-leak-scan.mjs. */
const RUN_DIRECTLY = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (RUN_DIRECTLY) main().catch((err) => fail(err?.message ?? String(err)));
