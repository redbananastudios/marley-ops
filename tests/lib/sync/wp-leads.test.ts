import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

/**
 * The Pitmans WordPress pull rail (lib/sync/wp-leads.ts) — the half of gate
 * 19's ingest that makes push failures recoverable instead of silent. The
 * behaviours pinned here are each a way to lose or duplicate a customer:
 * the id contract drifting from the plugin's, the brand not being stamped,
 * an unconfigured rail reading as a clean check, or a submission the rail
 * has seen failing to become a standing visible fact.
 */

const landCalls: { input: Record<string, unknown>; result: { created: boolean } }[] = [];
const issueCalls: { key: string; message: string }[] = [];
const resolveCalls: string[] = [];
const pushEvents: unknown[] = [];

/** Which external ids the fake DB "already holds" — landWebsiteLead adopts those. */
let existingExternalIds: Set<string> = new Set();

vi.mock("@/lib/leads/website-lead", () => ({
  landWebsiteLead: async (_sb: unknown, input: { externalLeadId?: string | null }) => {
    const created = !existingExternalIds.has(input.externalLeadId ?? "");
    const result = { leadId: `lead-for-${input.externalLeadId}`, created, alertSubmittedAt: null };
    landCalls.push({ input: input as Record<string, unknown>, result: { created } });
    return result;
  },
  toTimestampOrNull: (s?: string | null) => {
    if (!s) return null;
    return isNaN(new Date(s).getTime()) ? null : s;
  },
}));

vi.mock("@/lib/ops/issues", () => ({
  reportOperationalIssue: async (_sb: unknown, issue: { key: string; message: string }) => {
    issueCalls.push({ key: issue.key, message: issue.message });
  },
  resolveOperationalIssue: async (_sb: unknown, key: string) => {
    resolveCalls.push(key);
  },
}));

vi.mock("@/lib/push/send", () => ({
  sendPushForEvent: async (event: unknown) => {
    pushEvents.push(event);
  },
}));

import {
  buildPullUrl,
  resolveWpPullConfig,
  signPullQuery,
  syncWpLeads,
  WP_PULL_BRAND,
  WP_PULL_LIMIT,
  WP_RECONCILE_ISSUE_KEY,
  wpExternalLeadId,
} from "@/lib/sync/wp-leads";
import { websiteLeadIngestSchema } from "@/lib/leads/ingest";

const SB = {} as never;
const NOW = new Date("2026-08-26T12:00:00Z");
const URL_ENV = "https://pitmansremovals.co.uk/wp-json/pitmans-lead-bridge/v1/submissions";
const SECRET = "0123456789abcdef0123456789abcdef";

function submission(id: number, ingest: Record<string, unknown>, over: Record<string, unknown> = {}) {
  return {
    id,
    form_id: 123,
    submitted_at: "2026-08-26T11:00:00Z",
    pushed_at: null,
    payload: { ingest, raw: {} },
    ...over,
  };
}

function fetchReturning(body: unknown, status = 200): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
}

beforeEach(() => {
  landCalls.length = 0;
  issueCalls.length = 0;
  resolveCalls.length = 0;
  pushEvents.length = 0;
  existingExternalIds = new Set();
  vi.stubEnv("PITMANS_WP_PULL_URL", URL_ENV);
  vi.stubEnv("PITMANS_WP_PULL_SECRET", SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("wpExternalLeadId — the id contract shared with the plugin", () => {
  it("zero-pads to 6 digits so the id clears the ingest schema's 8-char floor", () => {
    expect(wpExternalLeadId(1)).toBe("wp-000001");
    expect(wpExternalLeadId(42)).toBe("wp-000042");
    expect(wpExternalLeadId(999999)).toBe("wp-999999");
    // Past the pad width the id simply grows — never wraps or collides.
    expect(wpExternalLeadId(1234567)).toBe("wp-1234567");
  });

  it("every derived id is accepted by the ingest schema's leadId rules", () => {
    for (const id of [1, 999999, 1234567]) {
      const parsed = websiteLeadIngestSchema.safeParse({
        leadId: wpExternalLeadId(id),
        name: "Test",
        phone: "07572000000",
      });
      expect(parsed.success, `id ${id}`).toBe(true);
    }
  });
});

describe("signPullQuery — the HMAC contract shared with the plugin", () => {
  it("signs exactly 'limit=<n>&ts=<unix>' with SHA-256 hex", () => {
    const expected = createHmac("sha256", SECRET).update("limit=200&ts=1756209600").digest("hex");
    expect(signPullQuery(200, 1756209600, SECRET)).toBe(expected);
  });

  it("buildPullUrl carries limit, ts and sig as query params", () => {
    const url = new URL(buildPullUrl(URL_ENV, 200, 1756209600, SECRET));
    expect(url.searchParams.get("limit")).toBe("200");
    expect(url.searchParams.get("ts")).toBe("1756209600");
    expect(url.searchParams.get("sig")).toBe(signPullQuery(200, 1756209600, SECRET));
  });
});

describe("resolveWpPullConfig", () => {
  it("both vars absent → 'absent' (ship-ahead, not an error)", () => {
    expect(resolveWpPullConfig({}).state).toBe("absent");
  });

  it("half-set pairs are 'broken' in either direction — someone tried and failed", () => {
    expect(resolveWpPullConfig({ PITMANS_WP_PULL_URL: URL_ENV }).state).toBe("broken");
    expect(resolveWpPullConfig({ PITMANS_WP_PULL_SECRET: SECRET }).state).toBe("broken");
  });

  it("a placeholder-short secret is 'broken', never quietly accepted", () => {
    expect(resolveWpPullConfig({ PITMANS_WP_PULL_URL: URL_ENV, PITMANS_WP_PULL_SECRET: "short" }).state).toBe("broken");
  });

  it("a full plausible pair is 'configured'", () => {
    const cfg = resolveWpPullConfig({ PITMANS_WP_PULL_URL: URL_ENV, PITMANS_WP_PULL_SECRET: SECRET });
    expect(cfg.state).toBe("configured");
  });

  it("a plaintext http:// URL is 'broken' — this response carries whole customer records", () => {
    // The poll returns up to WP_PULL_LIMIT rows of name/phone/email/addresses and
    // signs the request in the query string, so a downgraded URL must fail loudly
    // rather than quietly ship PII in cleartext every 15 minutes.
    const cfg = resolveWpPullConfig({
      PITMANS_WP_PULL_URL: URL_ENV.replace("https://", "http://"),
      PITMANS_WP_PULL_SECRET: SECRET,
    });
    expect(cfg.state).toBe("broken");
    expect(cfg.state === "broken" && cfg.reason).toContain("https://");
  });

  it("a non-URL value is still 'broken'", () => {
    expect(
      resolveWpPullConfig({ PITMANS_WP_PULL_URL: "pitmansremovals.co.uk", PITMANS_WP_PULL_SECRET: SECRET }).state,
    ).toBe("broken");
  });
});

describe("syncWpLeads", () => {
  it("unconfigured is LOUD but not a failed run — and never touches the network", async () => {
    vi.stubEnv("PITMANS_WP_PULL_URL", "");
    vi.stubEnv("PITMANS_WP_PULL_SECRET", "");
    const fetchImpl = vi.fn();
    const summary = await syncWpLeads(SB, { now: NOW, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(summary.ok).toBe(true);
    expect(summary.configured).toBe(false);
    expect(summary.warning).toContain("NOT running");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a half-configured pair is a FAILED run, not 'disabled and fine'", async () => {
    vi.stubEnv("PITMANS_WP_PULL_SECRET", "");
    const summary = await syncWpLeads(SB, { now: NOW, fetchImpl: fetchReturning({}) });
    expect(summary.ok).toBe(false);
    expect(summary.error).toContain("PITMANS_WP_PULL_SECRET");
  });

  it("an unreachable endpoint is a FAILED run — never an empty clean result", async () => {
    const fetchImpl = (async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as unknown as typeof fetch;
    const summary = await syncWpLeads(SB, { now: NOW, fetchImpl });
    expect(summary.ok).toBe(false);
    expect(summary.error).toContain("ENOTFOUND");
    expect(landCalls.length).toBe(0);
  });

  it("a rejecting endpoint (403 bad signature) is a FAILED run carrying the status", async () => {
    const summary = await syncWpLeads(SB, { now: NOW, fetchImpl: fetchReturning({ code: "plb_forbidden" }, 403) });
    expect(summary.ok).toBe(false);
    expect(summary.error).toContain("403");
  });

  it("reconciles: already-pushed rows are adopted, missed rows are landed as brand pitmans", async () => {
    existingExternalIds = new Set(["wp-000001"]);
    const body = {
      ok: true,
      // Endpoint order is newest-first; the rail must land oldest-first.
      submissions: [
        submission(2, { name: "Missed Customer", phone: "07572000001" }),
        submission(1, { name: "Pushed Customer", phone: "07572000002" }, { pushed_at: "2026-08-26T11:00:01Z" }),
      ],
    };
    const summary = await syncWpLeads(SB, { now: NOW, fetchImpl: fetchReturning(body) });

    expect(summary).toMatchObject({ ok: true, configured: true, seen: 2, alreadyPresent: 1, inserted: 1, failures: 0 });
    // Oldest first, id contract applied, brand stamped on every call.
    expect(landCalls.map((c) => c.input.externalLeadId)).toEqual(["wp-000001", "wp-000002"]);
    expect(landCalls.every((c) => c.input.brand === WP_PULL_BRAND)).toBe(true);
    // A clean pass clears the standing reconcile issue.
    expect(resolveCalls).toContain(WP_RECONCILE_ISSUE_KEY);
    expect(issueCalls.length).toBe(0);
  });

  it("a recovered FRESH lead pages the office, exactly like the other delivery routes", async () => {
    const body = {
      submissions: [submission(3, { name: "Fresh", phone: "07572000003", submittedAt: NOW.toISOString() })],
    };
    const summary = await syncWpLeads(SB, { now: NOW, fetchImpl: fetchReturning(body) });
    expect(summary.inserted).toBe(1);
    expect(pushEvents.length).toBe(1);
  });

  it("a submission the ingest contract refuses becomes a STANDING issue, not a dead run", async () => {
    const body = {
      submissions: [
        // No phone AND no email — the same payload the push route would 400.
        submission(4, { name: "Unreachable Person" }),
        submission(5, { name: "Fine", phone: "07572000005" }),
      ],
    };
    const summary = await syncWpLeads(SB, { now: NOW, fetchImpl: fetchReturning(body) });
    // The rail is alive — ok stays true so this cannot page as a dead rail —
    // but the failure is counted and reported where a human will see it.
    expect(summary).toMatchObject({ ok: true, seen: 2, inserted: 1, failures: 1 });
    expect(summary.firstError).toContain("wp-000004");
    expect(issueCalls.map((i) => i.key)).toContain(WP_RECONCILE_ISSUE_KEY);
  });

  it("an unusable response body is a FAILED run", async () => {
    const summary = await syncWpLeads(SB, { now: NOW, fetchImpl: fetchReturning({ nope: true }) });
    expect(summary.ok).toBe(false);
    expect(summary.error).toContain("unusable");
  });

  it("polls with the documented limit and a signature the plugin will accept", async () => {
    let seenUrl = "";
    const fetchImpl = (async (url: string) => {
      seenUrl = String(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ submissions: [] }),
        text: async () => "",
      };
    }) as unknown as typeof fetch;
    await syncWpLeads(SB, { now: NOW, fetchImpl });
    const url = new URL(seenUrl);
    const limit = Number(url.searchParams.get("limit"));
    const ts = Number(url.searchParams.get("ts"));
    expect(limit).toBe(WP_PULL_LIMIT);
    expect(ts).toBe(Math.floor(NOW.getTime() / 1000));
    expect(url.searchParams.get("sig")).toBe(signPullQuery(limit, ts, SECRET));
  });
});
