/**
 * Google Ads read layer (server-only) — pulls Marley's ad spend + click/conversion
 * metrics so the dashboard can show cost-per-lead and ROAS. Marley account
 * 6230471191 sits under the RBS MCC (login-customer-id 2650624060).
 *
 * Auth: OAuth refresh-token → short-lived access token (cached in-module for its
 * lifetime so a page load doing 3 period queries refreshes at most once).
 *
 * GOTCHA (cost the marketing engine real money once): GAQL *queries* use snake_case
 * (metrics.cost_micros) but the REST *response* is camelCase proto-JSON
 * (metrics.costMicros). Read costMicros or spend silently zeroes out.
 *
 * Every call is fail-soft: missing creds / timeout / non-200 → null, and the UI
 * degrades to "not connected" rather than breaking.
 */

import "server-only";

export interface AdSpend {
  costGbp: number;
  clicks: number;
  impressions: number;
  conversions: number;
}

const API_VERSION = "v21";

let tokenCache: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string | null> {
  if (tokenCache && tokenCache.expiresAt > Date.now()) return tokenCache.token;

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.MARLEY_GOOGLE_ADS_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) return null;
    tokenCache = {
      token: data.access_token,
      expiresAt: Date.now() + ((data.expires_in ?? 3600) - 120) * 1000,
    };
    return tokenCache.token;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** YYYY-MM-DD in the server's local (Europe/London) time — matches the Ads account tz. */
function fmtDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Fetch account spend/metrics for the inclusive date range [from, to]. null on any failure. */
export async function fetchAdSpend(from: Date, to: Date): Promise<AdSpend | null> {
  const token = await getAccessToken();
  const customerId = process.env.GOOGLE_ADS_CUSTOMER_ID;
  const loginCustomerId = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
  const devToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  if (!token || !customerId || !devToken) return null;

  const query =
    "SELECT metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions " +
    `FROM customer WHERE segments.date BETWEEN '${fmtDate(from)}' AND '${fmtDate(to)}'`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(
      `https://googleads.googleapis.com/${API_VERSION}/customers/${customerId}/googleAds:search`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "developer-token": devToken,
          ...(loginCustomerId ? { "login-customer-id": loginCustomerId } : {}),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query }),
        signal: controller.signal,
        cache: "no-store",
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      results?: { metrics?: { costMicros?: string; clicks?: string; impressions?: string; conversions?: number } }[];
    };
    // FROM customer over a date range returns one row per day-less aggregate; sum to be safe.
    let micros = 0,
      clicks = 0,
      impressions = 0,
      conversions = 0;
    for (const r of data.results ?? []) {
      micros += Number(r.metrics?.costMicros ?? 0);
      clicks += Number(r.metrics?.clicks ?? 0);
      impressions += Number(r.metrics?.impressions ?? 0);
      conversions += Number(r.metrics?.conversions ?? 0);
    }
    return { costGbp: micros / 1_000_000, clicks, impressions, conversions };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
