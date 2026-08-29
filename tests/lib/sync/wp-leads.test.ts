import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  contiguousReconciledUpTo,
  resolveWpPullConfig,
  signPullQuery,
  syncWpLeads,
  WP_PULL_BRAND,
  WP_PULL_LIMIT,
  WP_RECONCILE_ISSUE_KEY,
  wpExternalLeadId,
} from "@/lib/sync/wp-leads";
import { websiteLeadIngestSchema } from "@/lib/leads/ingest";

/**
 * The cursor is read from OUR leads table, so the stub answers from the same
 * `existingExternalIds` fixture that decides what landWebsiteLead adopts —
 * one source of truth for what the fake DB holds, so a test cannot
 * accidentally describe a world where the two disagree.
 */
let cursorReadError: string | null = null;
const SB = {
  from: () => ({
    select: () => ({
      eq: () => ({
        like: async () =>
          cursorReadError
            ? { data: null, error: { message: cursorReadError } }
            : {
                data: [...existingExternalIds].map((id) => ({ external_lead_id: id })),
                error: null,
              },
      }),
    }),
  }),
} as never;
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

/**
 * A fake of the plugin's read endpoint over a given set of row ids: it answers
 * `id > since_id ORDER BY id ASC LIMIT limit` and reports `total`/`min_id` the
 * way plb_rest_submissions does.
 *
 * Modelled rather than a fixed body because what these tests pin is which rows
 * a cursor can REACH, and a stub that ignores `since_id` cannot express that —
 * it would answer the same page however wrong the cursor was, which is exactly
 * the bug.
 */
function fakePlugin(
  ids: readonly number[],
  opts: { reportMinId?: boolean; unlandable?: readonly number[] } = {},
) {
  const sorted = [...ids].sort((a, b) => a - b);
  const unlandable = new Set(opts.unlandable ?? []);
  /** The since_id of every poll, in order — one entry per HTTP request. */
  const polledFrom: number[] = [];
  const fetchImpl = (async (u: string) => {
    const url = new URL(String(u));
    const sinceId = Number(url.searchParams.get("since_id"));
    const limit = Number(url.searchParams.get("limit"));
    polledFrom.push(sinceId);
    const page = sorted.filter((id) => id > sinceId).slice(0, limit);
    const body = {
      ok: true,
      total: sorted.length,
      ...(opts.reportMinId === false ? {} : { min_id: sorted.length ? sorted[0] : null }),
      since_id: sinceId,
      submissions: page.map((id) =>
        submission(
          id,
          // An unlandable row is the real shape: no phone AND no email, which
          // the shared ingest contract refuses on both rails.
          unlandable.has(id) ? { name: `Customer ${id}` } : { name: `Customer ${id}`, phone: "07572000000" },
        ),
      ),
    };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  }) as unknown as typeof fetch;
  return { fetchImpl, polledFrom };
}

/** Our side already holds these plugin row ids. */
function held(ids: readonly number[]) {
  return new Set(ids.map((n) => wpExternalLeadId(n)));
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
  it("signs exactly 'limit=<n>&since_id=<n>&ts=<unix>' with SHA-256 hex", () => {
    const expected = createHmac("sha256", SECRET)
      .update("limit=200&since_id=7&ts=1756209600")
      .digest("hex");
    expect(signPullQuery(200, 7, 1756209600, SECRET)).toBe(expected);
  });

  it("since_id is INSIDE the signature, so a replay cannot advance the window", () => {
    // An on-path observer bumping since_id past a row would hide that row from
    // the only backstop the enquiry has.
    expect(signPullQuery(200, 7, 1756209600, SECRET)).not.toBe(
      signPullQuery(200, 8, 1756209600, SECRET),
    );
  });

  it("buildPullUrl carries limit, since_id, ts and sig as query params", () => {
    const url = new URL(buildPullUrl(URL_ENV, 200, 7, 1756209600, SECRET));
    expect(url.searchParams.get("limit")).toBe("200");
    expect(url.searchParams.get("since_id")).toBe("7");
    expect(url.searchParams.get("ts")).toBe("1756209600");
    expect(url.searchParams.get("sig")).toBe(signPullQuery(200, 7, 1756209600, SECRET));
  });
});

/**
 * The signing contract lives in three files that each claim to BE the spec and
 * each say "change both together or not at all" — this rail, the plugin, and
 * the plugin's README. They cannot be diffed by the type system, and the two
 * implementations stayed byte-matched through the since_id change while both
 * PROSE halves went on documenting the older `limit=<n>&ts=<unix>` string. A
 * spec that describes a string the code does not sign is worse than no spec:
 * the next person to touch either half implements the wrong one and the
 * signature silently stops verifying.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const readRepo = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), "utf8");

describe("the signing contract is described identically wherever it is described", () => {
  const SOURCES: [string, string][] = [
    ["the rail", "lib/sync/wp-leads.ts"],
    ["the plugin", "wordpress/pitmans-lead-bridge/pitmans-lead-bridge.php"],
    ["the plugin README", "wordpress/pitmans-lead-bridge/README.md"],
  ];

  it("the plugin builds the same canonical string this rail signs", () => {
    // The PHP half, verbatim. Both sides concatenate plain integers in this
    // order; signPullQuery's own test above pins the value it produces.
    expect(readRepo(SOURCES[1][1])).toContain(
      "$canonical = 'limit=' . $limit . '&since_id=' . $since_id . '&ts=' . $ts;",
    );
  });

  it("no half still documents the pre-since_id canonical string", () => {
    for (const [label, rel] of SOURCES) {
      const src = readRepo(rel);
      expect(src, `${label} documents the current canonical string`).toContain(
        "limit=<n>&since_id=<n>&ts=<unix",
      );
      expect(src, `${label} still documents the stale canonical string`).not.toMatch(
        /limit=<n>&ts=/,
      );
    }
  });
});

describe("contiguousReconciledUpTo", () => {
  it("stops at the first gap, so an unlanded row keeps coming back", () => {
    expect(contiguousReconciledUpTo(new Set())).toBe(0);
    expect(contiguousReconciledUpTo(new Set([1, 2, 3]))).toBe(3);
    // 4 is missing, so the window must reopen at 4 however many rows follow.
    expect(contiguousReconciledUpTo(new Set([1, 2, 3, 5, 6]))).toBe(3);
    // Without a floor to say otherwise, a set that does not start at 1 has
    // reconciled nothing contiguously — id 1 might exist and be unlanded.
    expect(contiguousReconciledUpTo(new Set([2, 3]))).toBe(0);
  });

  it("anchors to the table's real floor, so ids that never started at 1 still advance", () => {
    // The regression this pins: with the floor hardcoded to 1, a table numbered
    // from 5 returned 0 on every poll, so the rail asked for `id > 0` forever
    // and rows past the first page were offered by no poll ever again.
    expect(contiguousReconciledUpTo(new Set([5, 6, 7]), 5)).toBe(7);
    const held = new Set(Array.from({ length: 200 }, (_, i) => i + 5)); // 5..204
    expect(contiguousReconciledUpTo(held, 5)).toBe(204);
    // Unlike a genuine gap, this one is unclearable: no human action can land a
    // row that does not exist, so anchoring to 1 is a permanent pin.
    expect(contiguousReconciledUpTo(held)).toBe(0);
  });

  it("a gap ABOVE the floor still pins the window — an unlanded row must keep coming back", () => {
    // 8 is missing, so the rail must keep re-offering it rather than moving on.
    expect(contiguousReconciledUpTo(new Set([5, 6, 7, 9, 10]), 5)).toBe(7);
  });

  it("a floor above what we hold cannot skip a row — it costs re-reads, never a loss", () => {
    // The floor arrives from the endpoint. A wrong (or hostile) one must not be
    // able to advance the cursor past rows the rail has never landed.
    expect(contiguousReconciledUpTo(new Set(), 5000)).toBe(0);
    expect(contiguousReconciledUpTo(new Set([5, 6, 7]), 5000)).toBe(7);
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
      total: 2,
      // The endpoint now answers oldest-first FROM the cursor, so the rail lands
      // them in the order given. It used to answer newest-first and the rail
      // reversed; the ORDER LANDED is what matters and is unchanged.
      submissions: [
        submission(1, { name: "Pushed Customer", phone: "07572000002" }, { pushed_at: "2026-08-26T11:00:01Z" }),
        submission(2, { name: "Missed Customer", phone: "07572000001" }),
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
    const sinceId = Number(url.searchParams.get("since_id"));
    expect(limit).toBe(WP_PULL_LIMIT);
    expect(ts).toBe(Math.floor(NOW.getTime() / 1000));
    expect(url.searchParams.get("sig")).toBe(signPullQuery(limit, sinceId, ts, SECRET));
  });
});

/**
 * The loss must not be able to scroll out of the window, and the monitor must
 * not be able to clear its own evidence (QA-20260826-05). Before this, the
 * window was the plugin's NEWEST 200 rows: anything that fell behind it was
 * offered by no poll ever again, `failures` then read 0, and the standing
 * reconcile issue RESOLVED ITSELF — the surface that would have shown the gap
 * cleared by the gap.
 */
describe("syncWpLeads — the loss cannot scroll out of the window", () => {
  beforeEach(() => {
    cursorReadError = null;
    process.env.WP_PULL_URL = URL_ENV;
    process.env.WP_PULL_SECRET = SECRET;
  });

  it("a backlog the window never reached keeps the issue OPEN — failures:0 is not proof", async () => {
    // 200 rows landed, the plugin holds 250. The 50 it has never offered us are
    // invisible to this poll by construction, which is exactly why the poll must
    // not be allowed to conclude anything from its own emptiness.
    existingExternalIds = new Set(
      Array.from({ length: 200 }, (_, i) => wpExternalLeadId(i + 1)),
    );
    const summary = await syncWpLeads(SB, {
      now: NOW,
      fetchImpl: fetchReturning({ ok: true, total: 250, submissions: [] }),
    });
    expect(summary.failures).toBe(0);
    expect(summary.unaccounted).toBe(50);
    expect(resolveCalls).not.toContain(WP_RECONCILE_ISSUE_KEY);
    expect(issueCalls.map((i) => i.key)).toContain(WP_RECONCILE_ISSUE_KEY);
  });

  it("asks for rows AFTER the last one that landed, so nothing can fall behind", async () => {
    // A gap at 8 pins the window there: 9 onwards are held, but the rail must
    // keep re-offering 8 rather than moving past it.
    existingExternalIds = new Set(
      [1, 2, 3, 4, 5, 6, 7, 9, 10].map((n) => wpExternalLeadId(n)),
    );
    let seenUrl = "";
    const fetchImpl = (async (u: string) => {
      seenUrl = u;
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, total: 10, submissions: [] }),
        text: async () => "",
      };
    }) as unknown as typeof fetch;
    await syncWpLeads(SB, { now: NOW, fetchImpl });
    const url = new URL(seenUrl);
    expect(Number(url.searchParams.get("since_id"))).toBe(7);
  });

  it("an endpoint reporting no total never resolves the issue", async () => {
    // "I could not check" is a different answer from "nothing to report", and
    // the two must not share a rendering.
    existingExternalIds = new Set();
    const summary = await syncWpLeads(SB, {
      now: NOW,
      fetchImpl: fetchReturning({ ok: true, submissions: [] }),
    });
    expect(summary.unaccounted).toBeNull();
    expect(resolveCalls).not.toContain(WP_RECONCILE_ISSUE_KEY);
  });

  it("a fully reconciled rail DOES resolve — the issue is not permanently stuck open", async () => {
    existingExternalIds = new Set([1, 2, 3].map((n) => wpExternalLeadId(n)));
    const summary = await syncWpLeads(SB, {
      now: NOW,
      fetchImpl: fetchReturning({ ok: true, total: 3, submissions: [] }),
    });
    expect(summary.unaccounted).toBe(0);
    expect(summary.failures).toBe(0);
    expect(resolveCalls).toContain(WP_RECONCILE_ISSUE_KEY);
  });

  it("a table whose ids do not start at 1 still reaches the rows past the first page", async () => {
    // The regression: the cursor walked up from a hardcoded 1, so a plugin table
    // with no row 1 — a GDPR erasure, install-test rows cleared, an
    // AUTO_INCREMENT reseeded by a host move — pinned it at 0 on EVERY poll. The
    // rail then re-read the same oldest 200 rows and rows 205..254 were offered
    // by no poll, ever, with no human action able to clear it.
    const ids = Array.from({ length: 250 }, (_, i) => i + 5); // 5..254
    existingExternalIds = held(ids.slice(0, 200)); // 5..204 already landed
    const plugin = fakePlugin(ids);

    const summary = await syncWpLeads(SB, { now: NOW, fetchImpl: plugin.fetchImpl });

    // Anchored to the table's real floor, then re-polled from the corrected
    // cursor: the second window starts after the last row that landed.
    expect(plugin.polledFrom).toEqual([0, 204]);
    expect(summary.minId).toBe(5);
    expect(summary.sinceId).toBe(204);
    // The 50 rows the old window could never see are recovered.
    expect(summary.inserted).toBe(50);
    expect(landCalls.map((c) => c.input.externalLeadId)).toContain(wpExternalLeadId(254));
    // And with nothing left over, the standing issue is allowed to clear.
    expect(summary.unaccounted).toBe(0);
    expect(resolveCalls).toContain(WP_RECONCILE_ISSUE_KEY);
  });

  it("a row that can never land keeps being re-offered — the cursor stops beneath it", async () => {
    // The floor must not become a licence to skip. 8 exists and cannot land, so
    // the window has to reopen at 8 on every poll rather than moving past it.
    const ids = [5, 6, 7, 8, 9, 10, 11, 12];
    existingExternalIds = held([5, 6, 7, 9, 10, 11, 12]);
    const plugin = fakePlugin(ids, { unlandable: [8] });

    const summary = await syncWpLeads(SB, { now: NOW, fetchImpl: plugin.fetchImpl });

    expect(plugin.polledFrom).toEqual([0, 7]);
    expect(summary.sinceId).toBe(7);
    // Re-offered, refused again, and still a standing visible fact.
    expect(landCalls.map((c) => c.input.externalLeadId)).not.toContain(wpExternalLeadId(8));
    expect(summary.failures).toBe(1);
    expect(summary.firstError).toContain(wpExternalLeadId(8));
    expect(issueCalls.map((i) => i.key)).toContain(WP_RECONCILE_ISSUE_KEY);
    expect(resolveCalls).not.toContain(WP_RECONCILE_ISSUE_KEY);
  });

  it("a healthy rail costs ONE request — the re-anchor fires only when the floor lifts the cursor", async () => {
    const ids = Array.from({ length: 10 }, (_, i) => i + 1); // 1..10
    existingExternalIds = held(ids);
    const plugin = fakePlugin(ids);
    const summary = await syncWpLeads(SB, { now: NOW, fetchImpl: plugin.fetchImpl });
    expect(plugin.polledFrom).toEqual([10]);
    expect(summary.minId).toBe(1);
  });

  it("an endpoint that reports no floor keeps the SAFE floor of 1, never one guessed from what we hold", async () => {
    // Absent means unknown. Inferring the floor from our own lowest held id
    // would advance the cursor past ids that may exist and have never landed.
    const ids = [5, 6, 7];
    existingExternalIds = held(ids);
    const plugin = fakePlugin(ids, { reportMinId: false });
    const summary = await syncWpLeads(SB, { now: NOW, fetchImpl: plugin.fetchImpl });
    expect(plugin.polledFrom).toEqual([0]);
    expect(summary.sinceId).toBe(0);
    expect(summary.minId).toBeNull();
  });

  it("an unreadable leads table is a FAILED run, never a poll from zero", async () => {
    // Guessing the cursor is how a rail skips rows while reporting success: a
    // read failure treated as an empty set would reset the window to 0 and
    // re-offer every row as if new.
    existingExternalIds = new Set();
    cursorReadError = "connection terminated";
    let fetched = false;
    const fetchImpl = (async () => {
      fetched = true;
      return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
    }) as unknown as typeof fetch;
    const summary = await syncWpLeads(SB, { now: NOW, fetchImpl });
    expect(summary.ok).toBe(false);
    expect(summary.configured).toBe(true);
    expect(summary.error).toContain("cursor read failed");
    expect(fetched).toBe(false);
  });
});
