import { NextResponse } from "next/server";

import { requireAdminApi } from "@/lib/ai/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { getXeroConfig, readOrganisation } from "@/lib/ledger/xero-client";
import { assertWritable, isDemoOrg, liveWritesAllowed } from "@/lib/ledger/xero-guard";

/**
 * Is Xero connected, and would a write be allowed?
 *
 * Read-only by construction: it reads the token row and calls `GET
 * /Organisation`, and nothing else. It exists because "is Xero working?"
 * otherwise gets answered by trying to raise an invoice — and the whole point
 * of this phase is that nobody raises anything in the live organisation.
 *
 * The verdict runs the SAME `assertWritable` the adapter uses rather than
 * restating the rule, so this endpoint cannot drift into reassuring someone
 * about a guard that behaves differently from the one that actually fires.
 *
 * Admin-only, because the answer names the connected organisation.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await requireAdminApi())) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const configured = Boolean(getXeroConfig());
  const admin = createAdminClient();
  const { data: row, error } = await admin
    .from("ledger_tokens")
    .select("access_expires_at, tenant_id, rotated_at, refresh_lease_owner, refresh_lease_until")
    .eq("provider", "xero")
    .maybeSingle();

  if (error) {
    return NextResponse.json({ configured, connected: false, error: error.message }, { status: 500 });
  }
  if (!row) {
    return NextResponse.json({
      configured,
      connected: false,
      // The next action, not just the state — whoever opens this is trying to
      // get somewhere.
      next: configured
        ? "Nobody has authorised this environment yet. Open /api/xero/connect."
        : "Set XERO_CLIENT_ID, XERO_CLIENT_SECRET and XERO_REDIRECT_URI first.",
    });
  }

  const expiresAt = row.access_expires_at ? Date.parse(row.access_expires_at) : NaN;
  const org = await readOrganisation();
  const demo = isDemoOrg(org);

  let writes: string;
  try {
    assertWritable(org, "write");
    writes = demo
      ? "allowed — Demo Company"
      : "allowed — XERO_ALLOW_LIVE_WRITES is set, and this is a LIVE organisation";
  } catch (e) {
    writes = `REFUSED — ${e instanceof Error ? e.message : "unknown"}`;
  }

  return NextResponse.json({
    configured,
    connected: true,
    authorisedAt: row.rotated_at,
    tenantId: row.tenant_id,
    accessTokenMinutesLeft: Number.isFinite(expiresAt)
      ? Math.round((expiresAt - Date.now()) / 60000)
      : null,
    // A held lease is the first thing to look at when refreshes appear stuck.
    refreshLease: row.refresh_lease_owner
      ? { owner: row.refresh_lease_owner, until: row.refresh_lease_until }
      : null,
    organisation: { name: org.name ?? null, class: org.class ?? null, isDemo: demo },
    liveWriteFlagSet: liveWritesAllowed(),
    writes,
    // Stated even when everything is fine: an org that cannot be read is the
    // case where every other line above still looks healthy.
    ...(org.class
      ? {}
      : {
          warning:
            "The organisation could not be read. The refresh token may have been revoked, or " +
            "the Demo Company reset — re-authorise at /api/xero/connect.",
        }),
  });
}
