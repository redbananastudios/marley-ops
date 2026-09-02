import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The rotation trap (PRD §11.7 trap 8), pinned.
 *
 * Xero invalidates the refresh token the instant it is spent, so the window
 * between the token endpoint answering and the store writing the replacement
 * down is the one stretch of this integration where an ordinary transient
 * failure is UNRECOVERABLE: the row keeps a consumed token, and only Xero's
 * 30-minute grace stands between that and an `invalid_grant` lock-out needing a
 * human to re-consent. `lib/ledger/xero-client.ts`'s own header refuses to
 * treat that grace as the mechanism, so nothing may throw inside the window.
 *
 * No test here touches Xero — `fetch` is stubbed and the credentials do not
 * exist on this machine.
 */

vi.mock("server-only", () => ({}));

// The store is a different unit (and pulls Supabase in); only the refresh
// function is under test here.
vi.mock("@/lib/ledger/token-store", () => ({ getLedgerAccessToken: vi.fn() }));

import { LedgerError } from "@/lib/ledger/types";
import { refreshXeroTokens, XERO } from "@/lib/ledger/xero-client";

const state = vi.hoisted(() => ({
  /** What `GET /connections` answers with. */
  connections: null as Response | null,
  /** Every URL fetched, so a test can prove the order things happened in. */
  calls: [] as string[],
}));

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  state.connections = null;
  state.calls = [];
  process.env.XERO_CLIENT_ID = "client-id";
  process.env.XERO_CLIENT_SECRET = "client-secret";
  process.env.XERO_REDIRECT_URI = "https://ops.example/api/xero/callback";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      state.calls.push(url);
      if (url === XERO.token) {
        return json({ access_token: "at-new", refresh_token: "rt-new", expires_in: 1800 });
      }
      if (url === XERO.connections) {
        if (!state.connections) throw new Error("no /connections fixture queued");
        return state.connections;
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
});

const org = (tenantId: string, tenantName: string) => ({
  tenantId,
  tenantName,
  tenantType: "ORGANISATION",
});

describe("refreshXeroTokens — the rotated token always survives the tenant lookup", () => {
  it("resolves the tenant on the happy path", async () => {
    state.connections = json([org("tenant-1", "Demo Company (UK)")]);
    await expect(refreshXeroTokens("rt-old")).resolves.toMatchObject({
      accessToken: "at-new",
      refreshToken: "rt-new",
      tenantId: "tenant-1",
    });
    // The ordering is what makes the rest of this block matter: the lookup runs
    // strictly after the rotation has been spent, so it can never be the thing
    // that decides whether the replacement is returned.
    expect(state.calls).toEqual([XERO.token, XERO.connections]);
  });

  /**
   * Xero meters `/connections` per tenant, so a 429 here is an ordinary blip —
   * but it lands strictly AFTER the rotation has been spent. Throwing would
   * discard `rt-new` in a dead stack frame.
   */
  it("still returns the new refresh token when /connections is rate limited", async () => {
    state.connections = json({}, 429);
    const out = await refreshXeroTokens("rt-old");
    expect(out.refreshToken).toBe("rt-new");
    // undefined, not null: the store must leave the recorded tenant alone
    // rather than clearing a value it could not re-read.
    expect(out.tenantId).toBeUndefined();
    expect((out.deferredError as LedgerError).message).toMatch(/connections lookup failed \(HTTP 429\)/);
  });

  /**
   * The permanent variant, and the expensive one: a second organisation on the
   * same connection makes the lookup throw on EVERY refresh, so each pass burns
   * a fresh rotation that is immediately discarded until the grace lapses and
   * the integration is locked out of the live books with no self-heal.
   *
   * The refusal itself is right and stays — ambiguity yields nothing — it just
   * must not cost the connection to state it.
   */
  it("still returns the new refresh token when the connection grants two organisations", async () => {
    state.connections = json([org("tenant-1", "One Ltd"), org("tenant-2", "Two Ltd")]);
    const out = await refreshXeroTokens("rt-old");
    expect(out.refreshToken).toBe("rt-new");
    expect(out.tenantId).toBeUndefined();
    expect((out.deferredError as LedgerError).message).toMatch(/grants access to 2 organisations/);
  });

  it("carries no deferred failure when the lookup succeeds", async () => {
    state.connections = json([org("tenant-1", "Demo Company (UK)")]);
    const out = await refreshXeroTokens("rt-old");
    expect(out.deferredError).toBeUndefined();
  });

  /**
   * A connection with no ORGANISATION row is not a failure — it is a real
   * answer of "none", which `xeroAuth` turns into the re-authorise message.
   */
  it("reports no tenant as null rather than as a deferred failure", async () => {
    state.connections = json([]);
    const out = await refreshXeroTokens("rt-old");
    expect(out.tenantId).toBeNull();
    expect(out.deferredError).toBeUndefined();
  });

  /**
   * The one thing that MUST still throw from inside the window: a response with
   * no replacement token leaves nothing to persist, so there is no rotation to
   * protect and the next refresh has nothing to spend.
   */
  it("still throws when Xero honours no rotation at all", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ access_token: "at-new", expires_in: 1800 })),
    );
    await expect(refreshXeroTokens("rt-old")).rejects.toThrow(/no new refresh token/);
  });
});
