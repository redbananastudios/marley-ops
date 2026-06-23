/**
 * Marley — Google Ads offline conversion upload.
 *
 * The permanent fix for under-counted Ads conversions: ad-blockers/ITP drop the
 * client-side generate_lead beacon (~half of leads). This job reads the leads that
 * actually landed (Sanity quoteSubmission) with a paid click id (gclid/gbraid — now
 * reliably captured via the landing cookie) and uploads them to Google Ads by click
 * id, so Google sees every paid lead regardless of browser blocking.
 *
 * SAFE BY DEFAULT:
 *   - No args / --list   : list candidate leads only (no Ads call, no writes).
 *   - --dry-run          : call Ads with validateOnly=true (validates, records nothing).
 *   - --commit           : real upload + stamp adsUploadedAt on the lead (idempotent).
 *
 * Idempotency: a lead with `adsUploadedAt` set is skipped, so re-runs never
 * double-upload. Requires MARLEY_ADS_OFFLINE_CONVERSION_ACTION (the upload
 * conversion action resource name) for --dry-run/--commit.
 *
 * Env: SANITY_PROJECT_ID, SANITY_DATASET, SANITY_TOKEN (write needed for --commit),
 *      GOOGLE_OAUTH_CLIENT_ID/SECRET, MARLEY_GOOGLE_ADS_REFRESH_TOKEN,
 *      GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_CUSTOMER_ID, GOOGLE_ADS_LOGIN_CUSTOMER_ID,
 *      MARLEY_ADS_OFFLINE_CONVERSION_ACTION, [MARLEY_LEAD_VALUE_GBP].
 */

const API = "v21";
const args = new Set(process.argv.slice(2));
const MODE = args.has("--commit") ? "commit" : args.has("--dry-run") ? "dry-run" : "list";
const sinceArg = [...args].find((a) => a.startsWith("--since="))?.split("=")[1];
const SINCE = sinceArg || new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);

const PROJECT = process.env.SANITY_PROJECT_ID || "963i5lvk";
const DATASET = process.env.SANITY_DATASET || "production";
const SANITY_TOKEN = process.env.SANITY_TOKEN || process.env.SANITY_API_WRITE_TOKEN || process.env.SANITY_API_READ_TOKEN;
const LEAD_VALUE = Number(process.env.MARLEY_LEAD_VALUE_GBP || 0); // 0 = no value sent

function die(msg) {
  console.error("ERROR:", msg);
  process.exit(1);
}
if (!SANITY_TOKEN) die("No Sanity token (SANITY_TOKEN / SANITY_API_WRITE_TOKEN).");

/** Sanity GROQ query. */
async function sanityQuery(query) {
  const url = `https://${PROJECT}.api.sanity.io/v2021-10-21/data/query/${DATASET}?query=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${SANITY_TOKEN}` } });
  if (!res.ok) die(`Sanity query failed ${res.status}: ${await res.text()}`);
  return (await res.json()).result;
}

/** Stamp adsUploadedAt on a lead so re-runs skip it. */
async function markUploaded(id, when) {
  const res = await fetch(`https://${PROJECT}.api.sanity.io/v2021-10-21/data/mutate/${DATASET}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SANITY_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ mutations: [{ patch: { id, set: { adsUploadedAt: when } } }] }),
  });
  if (!res.ok) console.error(`  ! mark failed for ${id}: ${res.status} ${await res.text()}`);
}

async function adsAccessToken() {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      refresh_token: process.env.MARLEY_GOOGLE_ADS_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) die(`Ads token failed: ${await res.text()}`);
  return (await res.json()).access_token;
}

/** "YYYY-MM-DD HH:MM:SS+00:00" from an ISO timestamp (Ads requires an offset). */
function adsDateTime(iso) {
  return new Date(iso).toISOString().replace("T", " ").replace(/\.\d+Z$/, "+00:00");
}

async function main() {
  console.log(`Marley offline conversions — mode=${MODE}, since=${SINCE}`);

  // Candidate leads: a paid click id, landed since the cutoff, not yet uploaded.
  const leads = await sanityQuery(
    `*[_type=="quoteSubmission" && submittedAt >= "${SINCE}T00:00:00Z" && (defined(gclid) || defined(gbraid)) && !defined(adsUploadedAt)]` +
      `|order(submittedAt asc){_id,name,submittedAt,gclid,gbraid,utmCampaign}`,
  );
  console.log(`Candidates (paid click id, not yet uploaded): ${leads.length}`);
  for (const l of leads) {
    console.log(
      `  - ${l.submittedAt} | ${l.name} | ${l.gclid ? "gclid" : "gbraid"}=${(l.gclid || l.gbraid).slice(0, 16)}… | ${l.utmCampaign || "-"}`,
    );
  }
  if (MODE === "list" || leads.length === 0) {
    if (MODE === "list") console.log("\nlist mode — no Ads call. Re-run with --dry-run (validate) or --commit (upload).");
    return;
  }

  const action = process.env.MARLEY_ADS_OFFLINE_CONVERSION_ACTION;
  const customer = process.env.GOOGLE_ADS_CUSTOMER_ID;
  if (!action || !customer) die("Set MARLEY_ADS_OFFLINE_CONVERSION_ACTION + GOOGLE_ADS_CUSTOMER_ID.");

  const conversions = leads.map((l) => ({
    gclid: l.gclid || undefined,
    gbraid: l.gbraid || undefined,
    conversionAction: action,
    conversionDateTime: adsDateTime(l.submittedAt),
    ...(LEAD_VALUE > 0 ? { conversionValue: LEAD_VALUE, currencyCode: "GBP" } : {}),
  }));

  const token = await adsAccessToken();
  const res = await fetch(`https://googleads.googleapis.com/${API}/customers/${customer}:uploadClickConversions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "developer-token": process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
      "login-customer-id": process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ conversions, partialFailure: true, validateOnly: MODE === "dry-run" }),
  });
  const out = await res.json();
  if (!res.ok) die(`Ads upload failed ${res.status}: ${JSON.stringify(out)}`);

  const results = out.results || [];
  const failed = out.partialFailureError;
  console.log(`\nAds accepted: ${results.filter(Boolean).length}/${conversions.length}${MODE === "dry-run" ? " (validateOnly — nothing recorded)" : ""}`);
  if (failed) console.log("partialFailure:", JSON.stringify(failed).slice(0, 800));

  if (MODE === "commit") {
    const now = new Date().toISOString();
    for (let i = 0; i < leads.length; i++) {
      if (results[i]) await markUploaded(leads[i]._id, now);
    }
    console.log("Stamped adsUploadedAt on uploaded leads (idempotent).");
  }
}

main().catch((e) => die(e.message || String(e)));
