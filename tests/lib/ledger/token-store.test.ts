import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The token store is the piece of the ledger seam that can lock the live books
 * out. Xero rotates the refresh token on every use, so a design that races
 * routinely survives only on the provider's 30-minute grace — and reveals
 * itself on the day the grace does not cover it. These tests pin the lease
 * behaviour that keeps that from happening.
 */

interface Row {
  provider: string;
  refresh_token: string;
  access_token: string | null;
  access_expires_at: string | null;
  tenant_id: string | null;
  refresh_lease_until: string | null;
  refresh_lease_owner: string | null;
  rotated_at?: string | null;
}

const state = vi.hoisted(() => ({
  row: null as Row | null,
  /** false simulates another container already holding the lease. */
  claimGranted: true,
  claimError: null as string | null,
  updateError: null as string | null,
  /** Every patch this module wrote, in order. */
  updates: [] as Record<string, unknown>[],
  /** Called on each row read, so a test can let a "winner" publish mid-wait. */
  onRead: null as null | (() => void),
}));

vi.mock("@/lib/supabase/admin", () => {
  const makeBuilder = () => {
    const b = {
      _select: null as string | null,
      _patch: null as Record<string, unknown> | null,
      select(cols: string) {
        b._select = cols;
        return b;
      },
      eq() {
        return b;
      },
      or() {
        return b;
      },
      update(patch: Record<string, unknown>) {
        b._patch = patch;
        return b;
      },
      async maybeSingle() {
        state.onRead?.();
        return { data: state.row, error: null };
      },
      then(res: (v: unknown) => unknown, rej: (e: unknown) => unknown) {
        const run = async () => {
          if (b._patch) state.updates.push(b._patch);
          // A chain ending in .select() is the lease CLAIM; anything else is a
          // plain write-back or release.
          if (b._select) {
            if (state.claimError) return { data: null, error: { message: state.claimError } };
            if (!state.claimGranted) return { data: [], error: null };
            state.row = { ...(state.row as Row), ...(b._patch ?? {}) };
            return { data: [state.row], error: null };
          }
          if (state.updateError) return { error: { message: state.updateError } };
          state.row = { ...(state.row as Row), ...(b._patch ?? {}) };
          return { error: null };
        };
        return run().then(res, rej);
      },
    };
    return b;
  };
  return { createAdminClient: () => ({ from: () => makeBuilder() }) };
});

import { getLedgerAccessToken, type RefreshedTokens } from "@/lib/ledger/token-store";

const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();

function seed(over: Partial<Row> = {}): void {
  state.row = {
    provider: "xero",
    refresh_token: "rt0",
    access_token: "at0",
    access_expires_at: iso(30 * 60_000),
    tenant_id: "tenant-1",
    refresh_lease_until: null,
    refresh_lease_owner: null,
    ...over,
  };
}

beforeEach(() => {
  state.row = null;
  state.claimGranted = true;
  state.claimError = null;
  state.updateError = null;
  state.updates = [];
  state.onRead = null;
});

const rotated: RefreshedTokens = {
  accessToken: "at1",
  expiresInSeconds: 1800,
  refreshToken: "rt1",
  tenantId: "tenant-1",
};

describe("cached token", () => {
  it("returns the cached access token without touching the provider", async () => {
    seed();
    const refresh = vi.fn();
    await expect(getLedgerAccessToken("xero", refresh, "own-1")).resolves.toEqual({
      accessToken: "at0",
      tenantId: "tenant-1",
    });
    expect(refresh).not.toHaveBeenCalled();
    expect(state.updates).toHaveLength(0);
  });

  /** 5-minute safety margin, mirroring lib/zoho.ts. */
  it("refreshes when the cached token is inside the safety margin, not only when expired", async () => {
    seed({ access_expires_at: iso(2 * 60_000) });
    const refresh = vi.fn().mockResolvedValue(rotated);
    await expect(getLedgerAccessToken("xero", refresh, "own-1")).resolves.toMatchObject({
      accessToken: "at1",
    });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("refreshes when there is a refresh token but no access token yet", async () => {
    seed({ access_token: null, access_expires_at: null });
    const refresh = vi.fn().mockResolvedValue(rotated);
    await expect(getLedgerAccessToken("xero", refresh, "own-1")).resolves.toMatchObject({
      accessToken: "at1",
    });
  });
});

describe("claiming the lease and rotating", () => {
  beforeEach(() => seed({ access_expires_at: iso(-1000) }));

  it("hands the CURRENT refresh token to the provider", async () => {
    const refresh = vi.fn().mockResolvedValue(rotated);
    await getLedgerAccessToken("xero", refresh, "own-1");
    expect(refresh).toHaveBeenCalledWith("rt0");
  });

  /**
   * The whole reason this table exists: a rotating provider invalidates the old
   * refresh token the instant it is used. Failing to persist the new one is an
   * unrecoverable lockout, not a retryable write.
   */
  it("persists the ROTATED refresh token, not the one it started with", async () => {
    await getLedgerAccessToken("xero", vi.fn().mockResolvedValue(rotated), "own-1");
    expect(state.row?.refresh_token).toBe("rt1");
    expect(state.row?.access_token).toBe("at1");
  });

  it("clears the lease after a successful rotation so the next refresh is not blocked", async () => {
    await getLedgerAccessToken("xero", vi.fn().mockResolvedValue(rotated), "own-1");
    expect(state.row?.refresh_lease_until).toBeNull();
    expect(state.row?.refresh_lease_owner).toBeNull();
  });

  it("stamps the claim with the owner so a stuck lease can be traced to a process", async () => {
    await getLedgerAccessToken("xero", vi.fn().mockResolvedValue(rotated), "own-1");
    expect(state.updates[0]).toMatchObject({ refresh_lease_owner: "own-1" });
    expect(state.updates[0].refresh_lease_until).toEqual(expect.any(String));
  });

  it("releases the lease when the provider refresh fails, and rethrows", async () => {
    const boom = new Error("xero 400 invalid_grant");
    await expect(
      getLedgerAccessToken("xero", vi.fn().mockRejectedValue(boom), "own-1"),
    ).rejects.toBe(boom);
    expect(state.row?.refresh_lease_until).toBeNull();
    expect(state.row?.refresh_lease_owner).toBeNull();
  });

  it("names the lockout plainly when the rotated token cannot be saved", async () => {
    state.updateError = "connection reset";
    await expect(
      getLedgerAccessToken("xero", vi.fn().mockResolvedValue(rotated), "own-1"),
    ).rejects.toThrow(/rotated but could not be saved/);
    await expect(
      getLedgerAccessToken("xero", vi.fn().mockResolvedValue(rotated), "own-1"),
    ).rejects.toThrow(/need re-authorising/);
  });
});

/**
 * A provider may hand back a failure it deliberately did NOT throw, because
 * throwing it would have happened inside the one window where a throw is
 * unrecoverable: after a rotating provider has spent the old refresh token and
 * before the replacement is written down. Xero's tenant lookup is that call.
 *
 * The contract is "persist first, then fail just as loudly" — so both halves
 * are asserted together. Asserting only the throw would pass against the very
 * bug this exists to stop, and asserting only the write would let the failure
 * be swallowed.
 */
describe("a failure the provider deferred until after the write", () => {
  beforeEach(() => seed({ access_expires_at: iso(-1000) }));

  it("persists the rotated token AND raises the deferred failure", async () => {
    const deferred = new Error("Xero connections lookup failed (HTTP 429)");
    await expect(
      getLedgerAccessToken("xero", vi.fn().mockResolvedValue({ ...rotated, deferredError: deferred }), "own-1"),
    ).rejects.toBe(deferred);
    expect(state.row?.refresh_token).toBe("rt1");
    expect(state.row?.access_token).toBe("at1");
  });

  /**
   * The next pass must be able to self-heal off the cached access token rather
   * than spending another rotation — which is the whole reason the write goes
   * first.
   */
  it("leaves the lease clear so the cached token is usable next pass", async () => {
    await expect(
      getLedgerAccessToken(
        "xero",
        vi.fn().mockResolvedValue({ ...rotated, tenantId: undefined, deferredError: new Error("boom") }),
        "own-1",
      ),
    ).rejects.toThrow(/boom/);
    expect(state.row?.refresh_lease_until).toBeNull();
    // tenantId undefined means "could not re-read it", never "there isn't one".
    expect(state.row?.tenant_id).toBe("tenant-1");
    await expect(getLedgerAccessToken("xero", vi.fn(), "own-1")).resolves.toMatchObject({
      accessToken: "at1",
    });
  });

  /** A write failure still wins: there is no rotation to report against. */
  it("reports the unsaved rotation, not the deferred failure, when the write fails", async () => {
    state.updateError = "connection reset";
    await expect(
      getLedgerAccessToken("xero", vi.fn().mockResolvedValue({ ...rotated, deferredError: new Error("boom") }), "own-1"),
    ).rejects.toThrow(/rotated but could not be saved/);
  });
});

describe("losing the claim", () => {
  it("waits for the winner's write instead of refreshing alongside it", async () => {
    seed({ access_expires_at: iso(-1000) });
    state.claimGranted = false;
    const refresh = vi.fn();
    // The "winner" publishes a fresh token before our first poll completes.
    state.onRead = () => {
      state.row = { ...(state.row as Row), access_token: "at-winner", access_expires_at: iso(30 * 60_000) };
      state.onRead = null;
    };
    await expect(getLedgerAccessToken("xero", refresh, "own-2")).resolves.toMatchObject({
      accessToken: "at-winner",
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  /**
   * On timeout this must THROW, never refresh in parallel. A stampede against a
   * rotating provider is how an integration locks itself out permanently; a
   * failed page load costs one browser refresh.
   */
  it("times out rather than starting a second refresh", async () => {
    vi.useFakeTimers();
    try {
      seed({ access_expires_at: iso(-1000) });
      state.claimGranted = false;
      const refresh = vi.fn();
      const pending = getLedgerAccessToken("xero", refresh, "own-2");
      const assertion = expect(pending).rejects.toThrow(/Timed out waiting/);
      await vi.advanceTimersByTimeAsync(11_000);
      await assertion;
      expect(refresh).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("missing state", () => {
  it("says a token row is missing rather than failing obscurely later", async () => {
    state.row = null;
    await expect(getLedgerAccessToken("xero", vi.fn(), "own-1")).rejects.toThrow(
      /No xero token row exists/,
    );
  });

  it("surfaces a failed claim as a claim failure, never as a granted claim", async () => {
    seed({ access_expires_at: iso(-1000) });
    state.claimError = "deadlock detected";
    await expect(getLedgerAccessToken("xero", vi.fn(), "own-1")).rejects.toThrow(
      /Could not claim the xero refresh lease/,
    );
  });
});
