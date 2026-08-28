import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/log", () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { log } from "@/lib/log";

/**
 * These tests exist because of a failure that produced no test failure, no
 * error, and no log line — for months.
 *
 * `API_VERSION` was pinned at `v21` long after Google retired it. Every
 * `fetchAdSpend` 404'd in ~30ms, `if (!res.ok) return null` swallowed it, and
 * the dashboard rendered its honest "Google Ads data unavailable right now."
 * So the UI never lied — but nothing anywhere could tell you the integration was
 * permanently dead rather than momentarily quiet, and it was found only while
 * root-causing an unrelated login stall (2026-08-28).
 *
 * Measured that day: v17/v19/v21 → HTTP 404, v22/v23 → HTTP 401 (alive, merely
 * unauthenticated). Google retires roughly three versions a year, so this WILL
 * happen again; the point of these tests is that the next time it does, the
 * evidence exists before anyone goes looking.
 */

const ENV_KEYS = [
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "MARLEY_GOOGLE_ADS_REFRESH_TOKEN",
  "GOOGLE_ADS_CUSTOMER_ID",
  "GOOGLE_ADS_DEVELOPER_TOKEN",
] as const;

const saved: Record<string, string | undefined> = {};

/** A token endpoint that succeeds, so tests reach the query call. */
function tokenOk() {
  return {
    ok: true,
    status: 200,
    json: async () => ({ access_token: "at", expires_in: 3600 }),
  } as unknown as Response;
}

beforeEach(async () => {
  vi.resetModules();
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    process.env[k] = "set";
  }
  vi.clearAllMocks();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

describe("fetchAdSpend — a dead integration must not read as a quiet one", () => {
  it("names a retired API version rather than returning a silent null", async () => {
    // The exact shape of the real defect: Google answers 404 for a version it
    // has withdrawn, forever, on every request.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("oauth2")
          ? tokenOk()
          : ({ ok: false, status: 404, text: async () => "Not Found" } as unknown as Response),
      ),
    );
    const { fetchAdSpend } = await import("@/lib/google-ads");

    await expect(fetchAdSpend(new Date("2026-08-01"), new Date("2026-08-28"))).resolves.toBeNull();
    expect(log.error).toHaveBeenCalledWith(
      "google_ads.api_version_retired",
      expect.objectContaining({ version: expect.any(String) }),
    );
  });

  it("distinguishes an ordinary API failure from a retired version", async () => {
    // A 403 is a permissions or quota problem — real, but a different job to do.
    // Collapsing the two would put the wrong fix in front of whoever reads it.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("oauth2")
          ? tokenOk()
          : ({ ok: false, status: 403, text: async () => "denied" } as unknown as Response),
      ),
    );
    const { fetchAdSpend } = await import("@/lib/google-ads");

    await expect(fetchAdSpend(new Date("2026-08-01"), new Date("2026-08-28"))).resolves.toBeNull();
    expect(log.error).toHaveBeenCalledWith(
      "google_ads.query_failed",
      expect.objectContaining({ status: 403 }),
    );
    expect(log.error).not.toHaveBeenCalledWith("google_ads.api_version_retired", expect.anything());
  });

  /**
   * The one silence that is correct. A brand with no Ads account is not a broken
   * integration, and logging it every render would train people to ignore the
   * lines that DO matter — which is how the retired version survived.
   */
  it("stays quiet when the integration is simply not configured", async () => {
    delete process.env.MARLEY_GOOGLE_ADS_REFRESH_TOKEN;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { fetchAdSpend } = await import("@/lib/google-ads");

    await expect(fetchAdSpend(new Date("2026-08-01"), new Date("2026-08-28"))).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("reports rejected credentials — configured and refused is not the same as absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 400, json: async () => ({}) }) as unknown as Response),
    );
    const { fetchAdSpend } = await import("@/lib/google-ads");

    await expect(fetchAdSpend(new Date("2026-08-01"), new Date("2026-08-28"))).resolves.toBeNull();
    expect(log.error).toHaveBeenCalledWith("google_ads.token_failed", { status: 400 });
  });

  /**
   * The GAQL gotcha that cost real money once, per the module's own header:
   * queries are snake_case but the REST response is camelCase proto-JSON. Read
   * `cost_micros` instead of `costMicros` and spend silently zeroes.
   */
  it("reads costMicros from the camelCase response, not cost_micros", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("oauth2")
          ? tokenOk()
          : ({
              ok: true,
              status: 200,
              json: async () => ({
                results: [{ metrics: { costMicros: "12500000", clicks: "40", impressions: "900", conversions: 3 } }],
              }),
            } as unknown as Response),
      ),
    );
    const { fetchAdSpend } = await import("@/lib/google-ads");

    await expect(fetchAdSpend(new Date("2026-08-01"), new Date("2026-08-28"))).resolves.toEqual({
      costGbp: 12.5,
      clicks: 40,
      impressions: 900,
      conversions: 3,
    });
  });
});
