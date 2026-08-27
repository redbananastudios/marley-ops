import { timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { requireAdminApi } from "@/lib/ai/auth";
import { log } from "@/lib/log";
import { createAdminClient } from "@/lib/supabase/admin";
import { exchangeAuthorisationCode, listConnections } from "@/lib/ledger/xero-client";
import { isDemoOrg } from "@/lib/ledger/xero-guard";
import { STATE_COOKIE } from "../connect/route";

/**
 * Where Xero sends the admin back after consent. Registered as this app's
 * OAuth 2.0 redirect URI, exactly:
 *
 *   prod     https://ops.marleymoves.co.uk/api/xero/callback
 *   staging  https://staging.ops.marleymoves.co.uk/api/xero/callback
 *
 * Exchanges the one-time code for the token pair and records it. This is the
 * FIRST writer of `ledger_tokens` — from here on `token-store.ts` owns the row
 * and rotates it under a lease.
 *
 * Nothing here is logged that could reconstruct the connection: no code, no
 * tokens, no client secret. What IS logged is which organisation was connected
 * and whether it is a demo, because that is the fact someone will need later
 * when they ask why writes are being refused.
 */
export const dynamic = "force-dynamic";

function htmlResult(title: string, body: string, status: number) {
  return new NextResponse(
    `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
      `<div style="font:16px/1.5 system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem">` +
      `<h1 style="font-size:1.25rem">${title}</h1>${body}</div>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

/** Constant-time compare, so the state check cannot be probed byte by byte. */
function sameState(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export async function GET(request: Request) {
  if (!(await requireAdminApi())) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const url = new URL(request.url);
  const jar = await cookies();
  const expected = jar.get(STATE_COOKIE)?.value ?? "";
  // One-time: cleared whatever happens next, so a replayed callback finds
  // nothing to match against.
  jar.delete(STATE_COOKIE);

  // Xero reports a refused or failed consent here rather than by not calling.
  const error = url.searchParams.get("error");
  if (error) {
    const description = url.searchParams.get("error_description") ?? "";
    log.warn("xero.authorise.declined", { error, description });
    return htmlResult(
      "Xero authorisation was not completed",
      `<p>Xero returned <code>${error}</code>. ${description}</p>` +
        `<p>Nothing was changed. Start again from <code>/api/xero/connect</code>.</p>`,
      400,
    );
  }

  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  if (!code || !state || !expected || !sameState(state, expected)) {
    // Deliberately one message for every one of those cases: distinguishing
    // "no cookie" from "wrong state" tells a prober which half to work on.
    log.warn("xero.authorise.state_mismatch", { hasCode: Boolean(code), hasCookie: Boolean(expected) });
    return htmlResult(
      "That authorisation link could not be verified",
      `<p>The request did not match a connection this browser started, so it was ignored ` +
        `and nothing was changed.</p><p>Start again from <code>/api/xero/connect</code>.</p>`,
      400,
    );
  }

  try {
    const tokens = await exchangeAuthorisationCode(code);
    if (!tokens.refreshToken) {
      // Without `offline_access` Xero issues no refresh token, and the
      // connection would silently die in thirty minutes.
      return htmlResult(
        "Xero returned no refresh token",
        `<p>The connection would expire in half an hour, so it was not saved. This usually ` +
          `means the <code>offline_access</code> scope was not granted.</p>`,
        502,
      );
    }

    // Which organisation did we just get? Refuse a connection granting more
    // than one — picking by position is a guess about whose books to use.
    const orgs = (await listConnections(tokens.accessToken)).filter(
      (c) => c.tenantType === "ORGANISATION",
    );
    if (orgs.length !== 1) {
      return htmlResult(
        "Grant access to exactly one organisation",
        `<p>This authorisation covers ${orgs.length} organisations. Ops writes to one set of ` +
          `books, and choosing between them here would be a guess — nothing was saved.</p>` +
          `<p>Start again and select a single organisation.</p>`,
        400,
      );
    }
    const tenantId = orgs[0].tenantId ?? null;
    const tenantName = orgs[0].tenantName ?? null;

    const admin = createAdminClient();
    const now = new Date().toISOString();
    const { error: writeError } = await admin.from("ledger_tokens").upsert(
      {
        provider: "xero",
        refresh_token: tokens.refreshToken,
        access_token: tokens.accessToken,
        access_expires_at: new Date(Date.now() + tokens.expiresInSeconds * 1000).toISOString(),
        tenant_id: tenantId,
        refresh_lease_until: null,
        refresh_lease_owner: null,
        rotated_at: now,
        updated_at: now,
      },
      { onConflict: "provider" },
    );
    if (writeError) {
      // The code is spent and cannot be replayed, so this is not retryable by
      // reloading — say so rather than leaving someone pressing refresh.
      log.error("xero.authorise.persist_failed", { error: writeError.message });
      return htmlResult(
        "Connected to Xero, but the tokens could not be saved",
        `<p>${writeError.message}</p><p>The authorisation code has already been spent, so ` +
          `reloading will not help — start again from <code>/api/xero/connect</code>.</p>`,
        500,
      );
    }

    // Read the org's class through the connection we just saved, so the page
    // states plainly whether writes are possible. Best-effort: a failure here
    // does not undo a good connection.
    const { readOrganisation } = await import("@/lib/ledger/xero-client");
    const org = await readOrganisation().catch(() => ({ class: null, scopeDenied: false }));
    const demo = isDemoOrg(org);

    log.info("xero.authorise.connected", { tenantName, orgClass: org.class, demo });

    return htmlResult(
      "Connected to Xero",
      `<p>Organisation: <strong>${tenantName ?? "(unnamed)"}</strong>` +
        `${org.class ? ` &middot; class <code>${org.class}</code>` : ""}</p>` +
        (org.scopeDenied
          ? `<p><strong>The organisation could not be read — Xero refused the request.</strong> ` +
            `That is a SCOPE problem, not a safety one: <code>accounting.settings.read</code> ` +
            `was almost certainly not granted. Until it is, every write will be refused for ` +
            `a reason that looks like the cutover guard but is not.</p>`
          : demo
            ? `<p>This is a Demo Company, so ops may read and write it freely.</p>`
            : `<p><strong>This is not a Demo Company, so ops will REFUSE every write to it.</strong> ` +
              `Reads work. That is deliberate until the cutover — see ` +
              `<code>XERO_ALLOW_LIVE_WRITES</code>.</p>`) +
        `<p>You can close this tab.</p>`,
      200,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    log.error("xero.authorise.failed", { error: message });
    return htmlResult(
      "Could not complete the Xero connection",
      `<p>${message}</p><p>Nothing was saved. Start again from <code>/api/xero/connect</code>.</p>`,
      502,
    );
  }
}
