#!/usr/bin/env node
/**
 * One-shot: exchange a Zoho **Self Client** grant code for a long-lived refresh
 * token, then VERIFY that token can see the staging org — so the E2E money path
 * runs against Demo Removals and can NEVER touch Connor's live books.
 *
 * Why this exists: the org is chosen per API call (X-com-zoho-invoice-org-id),
 * but a refresh token can only reach organizations that belong to the Zoho
 * ACCOUNT it was issued for. The staging org (demo@marleymoves.co.uk) is a
 * separate account from the live org, so it needs its own token. This keeps the
 * separation physical: the staging credentials literally cannot reach live.
 *
 * ── Browser prep (~5 min, signed in as the STAGING login demo@marleymoves.co.uk)
 *   1. Open the API console for the account's data centre:
 *        EU → https://api-console.zoho.eu     (Connor's live org is EU; the
 *        .com → https://api-console.zoho.com    staging org is very likely EU too)
 *      Check the DC by the Zoho Invoice URL bar: invoice.zoho.eu vs .com etc.
 *   2. Add Client → **Self Client** → Create. Copy the Client ID + Client Secret.
 *   3. "Generate Code" tab:
 *        Scope:  ZohoInvoice.fullaccess.all
 *        Time:   10 minutes
 *        (any description) → Generate → copy the grant code.
 *   4. Immediately run (the code expires in minutes):
 *
 *      node scripts/zoho-staging-token.mjs \
 *        --client-id   <self-client id> \
 *        --client-secret <self-client secret> \
 *        --code        <grant code> \
 *        --org         20117092566 \
 *        [--dc eu]     # eu (default) | com | in | au | jp | ca | sa
 *
 * On success it prints the refresh token + the .env.e2e block to paste.
 *
 * SAFETY: refuses the known live org id. It never writes anything to Zoho —
 * it only lists the account's orgs to confirm the staging org is reachable.
 */

const LIVE_ORG_ID = "20106952968"; // Connor's real Marley Moves Ltd books — never here.

const DC_HOSTS = {
  eu: { accounts: "https://accounts.zoho.eu", api: "https://www.zohoapis.eu" },
  com: { accounts: "https://accounts.zoho.com", api: "https://www.zohoapis.com" },
  in: { accounts: "https://accounts.zoho.in", api: "https://www.zohoapis.in" },
  au: { accounts: "https://accounts.zoho.com.au", api: "https://www.zohoapis.com.au" },
  jp: { accounts: "https://accounts.zoho.jp", api: "https://www.zohoapis.jp" },
  ca: { accounts: "https://accounts.zohocloud.ca", api: "https://www.zohoapis.ca" },
  sa: { accounts: "https://accounts.zoho.sa", api: "https://www.zohoapis.sa" },
};

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      out[key] = val;
    }
  }
  return out;
}

function die(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const clientId = args["client-id"] || process.env.ZOHO_STAGING_CLIENT_ID;
const clientSecret = args["client-secret"] || process.env.ZOHO_STAGING_CLIENT_SECRET;
const code = args["code"];
const orgId = args["org"] || process.env.ZOHO_STAGING_ORG_ID;
const dc = (args["dc"] || "eu").toLowerCase();

if (!clientId || !clientSecret) die("Need --client-id and --client-secret (from the Self Client).");
if (!code) die("Need --code (the grant code from the Self Client 'Generate Code' tab).");
if (!orgId) die("Need --org (the STAGING org id, e.g. 20117092566).");
if (orgId === LIVE_ORG_ID) die(`Refusing: ${orgId} is the LIVE org. This tool is staging-only.`);
if (!DC_HOSTS[dc]) die(`Unknown --dc "${dc}". One of: ${Object.keys(DC_HOSTS).join(", ")}.`);

const { accounts, api } = DC_HOSTS[dc];

async function main() {
  console.log(`\n→ Exchanging grant code at ${accounts} (dc=${dc})…`);
  const tokenRes = await fetch(`${accounts}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      code,
    }),
  });
  const token = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !token.refresh_token) {
    const hint =
      token.error === "invalid_code"
        ? " — the grant code expired or was already used; regenerate it and re-run within a few minutes."
        : token.error === "invalid_client"
          ? " — client id/secret wrong, or the Self Client is on a different data centre (try another --dc)."
          : "";
    die(`Token exchange failed: ${token.error || tokenRes.status}${hint}`);
  }

  console.log("→ Verifying the token can see the staging org…");
  const orgsRes = await fetch(`${api}/invoice/v3/organizations`, {
    headers: { Authorization: `Zoho-oauthtoken ${token.access_token}` },
  });
  const orgs = await orgsRes.json().catch(() => ({}));
  const list = orgs.organizations ?? [];
  const staging = list.find((o) => String(o.organization_id) === String(orgId));
  const seesLive = list.some((o) => String(o.organization_id) === LIVE_ORG_ID);

  if (!staging) {
    die(
      `Token works, but org ${orgId} is NOT in this account's orgs ` +
        `(${list.map((o) => `${o.name}=${o.organization_id}`).join(", ") || "none"}). ` +
        `Check the org id and the --dc.`,
    );
  }

  console.log(`\n✔ Staging org reachable: "${staging.name}" (${orgId}) on ${dc.toUpperCase()}.`);
  if (seesLive) {
    console.log(
      "⚠ NOTE: this token's account ALSO contains the live org — meaning Demo Removals\n" +
        "  was created under Connor's account, not a separate one. Still safe (we pin\n" +
        "  ZOHO_ORG_ID to staging), but the physical boundary you wanted isn't there.\n" +
        "  If you meant them separate, create the Self Client under the demo@ login instead.",
    );
  }

  const accountsUrl = accounts;
  const apiUrl = api;
  console.log(
    "\n────────── paste into .env.e2e (replace the pending block) ──────────\n" +
      `ZOHO_ORG_ID=${orgId}\n` +
      `ZOHO_CLIENT_ID=${clientId}\n` +
      `ZOHO_CLIENT_SECRET=${clientSecret}\n` +
      `ZOHO_REFRESH_TOKEN=${token.refresh_token}\n` +
      (dc === "eu" ? "" : `ZOHO_ACCOUNTS_URL=${accountsUrl}\nZOHO_API_URL=${apiUrl}\n`) +
      "─────────────────────────────────────────────────────────────────────\n" +
      "\nThen: mirror the VAT config in Demo Removals (20% output rate + FRS 10% +\n" +
      "registration date 2026-06-01), source .env.e2e into the dev server, reseed,\n" +
      "and the customer-accept + P0 #1–5 money tests un-gate.\n",
  );
}

main().catch((e) => die(e?.message || String(e)));
