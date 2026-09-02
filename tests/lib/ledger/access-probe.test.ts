import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Xero half of the watchdog's books probe.
 *
 * The health-probe rule (2026-08-27, learned from Zoho): a probe must fail
 * under the exact lock-out class it certifies against, not merely when the
 * host is down. Zoho's `GET /organizations` answered happily for a deactivated
 * user; Xero's `/connections` answers with just a bare token. So the Xero
 * probe reads `GET /Organisation` through the FULL chain — token refresh
 * (rotation alive), tenant recorded, tenant addressable under our scopes —
 * because each link is a real, observed way this integration dies silently.
 */

const client = vi.hoisted(() => ({
  xeroFetch: vi.fn(),
}));

vi.mock("@/lib/ledger/xero-client", () => client);

import { checkXeroAccess } from "@/lib/ledger/xero-access";
import { LedgerError } from "@/lib/ledger/types";

beforeEach(() => {
  client.xeroFetch.mockReset();
});

describe("checkXeroAccess", () => {
  it("probes the tenant-scoped Organisation read, not a bare-token endpoint", async () => {
    client.xeroFetch.mockResolvedValue(new Response("{}", { status: 200 }));
    const check = await checkXeroAccess();
    expect(check).toEqual({ ok: true });
    expect(client.xeroFetch).toHaveBeenCalledWith("/Organisation");
  });

  it("a dead or revoked refresh token is a lock-out", async () => {
    client.xeroFetch.mockRejectedValue(
      new LedgerError("Xero token request failed: invalid_grant", undefined, 400),
    );
    const check = await checkXeroAccess();
    expect(check).toMatchObject({ ok: false, accessDenied: true });
  });

  it("missing credentials are a lock-out — the alarm must not depend on the config it watches", async () => {
    client.xeroFetch.mockRejectedValue(
      new LedgerError(
        "Xero is not configured — XERO_CLIENT_ID, XERO_CLIENT_SECRET and XERO_REDIRECT_URI must all be set.",
      ),
    );
    const check = await checkXeroAccess();
    expect(check).toMatchObject({ ok: false, accessDenied: true });
  });

  it("a lost tenant (Demo Company reset) is a lock-out", async () => {
    client.xeroFetch.mockRejectedValue(
      new LedgerError(
        "No Xero tenant is recorded for this connection. If the Demo Company was reset, re-authorise with /api/xero/connect (admin only).",
      ),
    );
    const check = await checkXeroAccess();
    expect(check).toMatchObject({ ok: false, accessDenied: true });
  });

  /**
   * The link the probe reaches BEFORE any of the above: no stored token at
   * all. `ledger_tokens` lands empty on every environment, so a
   * `LEDGER_PROVIDER=xero` flip that runs ahead of /api/xero/connect — the
   * ordering the cutover actually has — puts the integration here, and so does
   * losing or rebuilding the row later. It needs the same human doing the same
   * thing as a revoked grant, so it must go red the same way rather than
   * retrying quietly behind a green probe.
   */
  it("a connection that was never authorised is a lock-out, not a blip", async () => {
    client.xeroFetch.mockRejectedValue(
      new LedgerError(
        "No xero token row exists — re-authorise at /api/xero/connect (admin only) before using the xero adapter.",
      ),
    );
    const check = await checkXeroAccess();
    expect(check).toMatchObject({ ok: false, accessDenied: true });
  });

  it("a disconnected organisation (401/403 on the read itself) is a lock-out", async () => {
    client.xeroFetch.mockResolvedValue(new Response("", { status: 403 }));
    const check = await checkXeroAccess();
    expect(check).toMatchObject({ ok: false, accessDenied: true });
    expect((check as { message: string }).message).toContain("403");
  });

  it("a 5xx or timeout is TRANSIENT — it must not page anyone at 3am", async () => {
    client.xeroFetch.mockResolvedValue(new Response("", { status: 503 }));
    expect(await checkXeroAccess()).toMatchObject({ ok: false, accessDenied: false });

    client.xeroFetch.mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    expect(await checkXeroAccess()).toMatchObject({ ok: false, accessDenied: false });
  });

  it("never throws — a probe failure IS the answer", async () => {
    client.xeroFetch.mockRejectedValue(new Error("fetch failed"));
    await expect(checkXeroAccess()).resolves.toMatchObject({ ok: false });
  });
});
