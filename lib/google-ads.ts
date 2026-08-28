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
 *
 * Fail-soft is NOT fail-silent, and the difference cost us months. `API_VERSION`
 * was pinned at "v21" long after Google retired it, so every call 404'd in ~30ms
 * and the dashboard's ad-spend, cost-per-lead and ROAS tiles sat blank — an
 * honest "unavailable" message with no way for anyone to learn WHY. It was found
 * only while root-causing an unrelated login stall (2026-08-28). Measured then:
 * v17/v19/v21 → 404, v22/v23 → 401 (i.e. alive, merely unauthenticated).
 *
 * So every failure path below now logs with enough context to act on, and a 404
 * gets its own named line saying the version has probably been retired. Google
 * retires roughly three versions a year; the next one should cost a log read.
 */

import "server-only";

import { log } from "@/lib/log";

export interface AdSpend {
  costGbp: number;
  clicks: number;
  impressions: number;
  conversions: number;
}

/**
 * Google retires roughly three versions a year and a retired one 404s rather
 * than failing loudly — see the header. When bumping, check the current version
 * against Google's release notes; an unauthenticated POST to
 * `https://googleads.googleapis.com/<version>/customers/1/googleAds:search`
 * answers 404 when the version is dead and 401 when it is alive.
 */
const API_VERSION = "v22";

let tokenCache: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string | null> {
  if (tokenCache && tokenCache.expiresAt > Date.now()) return tokenCache.token;

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.MARLEY_GOOGLE_ADS_REFRESH_TOKEN;
  // Unconfigured is a legitimate state (a brand with no Ads account), so this
  // stays quiet — it is the one "no data" that genuinely means "nothing to
  // report" rather than "I could not check".
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
    if (!res.ok) {
      // Credentials EXIST and were rejected — that is a broken integration, not
      // an absent one, and it must not read the same as "not connected".
      log.error("google_ads.token_failed", { status: res.status });
      return null;
    }
    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) {
      log.error("google_ads.token_missing_in_response", { status: res.status });
      return null;
    }
    tokenCache = {
      token: data.access_token,
      expiresAt: Date.now() + ((data.expires_in ?? 3600) - 120) * 1000,
    };
    return tokenCache.token;
  } catch (err) {
    // Includes the 5s AbortError. Timing out every time is indistinguishable
    // from "no spend" on the tile, so it has to be visible somewhere.
    log.warn("google_ads.token_error", { error: err instanceof Error ? err.message : String(err) });
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
  if (!token || !customerId || !devToken) {
    // A missing TOKEN here means getAccessToken already logged why. Missing
    // customer/developer ids alongside a working token is a half-configured
    // integration, which is worth saying out loud.
    if (token && (!customerId || !devToken)) {
      log.warn("google_ads.partially_configured", {
        hasCustomerId: !!customerId,
        hasDeveloperToken: !!devToken,
      });
    }
    return null;
  }

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
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (res.status === 404) {
        // The exact failure that hid for months. A retired version 404s on every
        // request forever, so this is permanent until someone bumps API_VERSION —
        // it is never a blip, and it should never read like one.
        log.error("google_ads.api_version_retired", {
          version: API_VERSION,
          hint: "Google has probably retired this API version — bump API_VERSION in lib/google-ads.ts",
        });
      } else {
        log.error("google_ads.query_failed", { status: res.status, version: API_VERSION, body: body.slice(0, 300) });
      }
      return null;
    }
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
  } catch (err) {
    log.warn("google_ads.query_error", { error: err instanceof Error ? err.message : String(err) });
    return null;
  } finally {
    clearTimeout(timer);
  }
}
