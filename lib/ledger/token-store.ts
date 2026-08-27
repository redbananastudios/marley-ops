/**
 * Persistent OAuth token store for the ledger seam — SERVER ONLY.
 *
 * Built at gate 17 so the adapter interface has somewhere to put it, even
 * though only the Xero adapter (gate 18) uses it. Nothing on a live money path
 * calls this module while `LEDGER_PROVIDER=zoho`.
 *
 * ## Why this exists at all
 *
 * Zoho's refresh token never rotates, so `lib/zoho.ts` holds all its auth state
 * in module-level per-process variables and reads `ZOHO_REFRESH_TOKEN` straight
 * from the environment. That works because every container can independently
 * derive a valid access token from a constant.
 *
 * **Xero rotates the refresh token on every use.** The moment one container
 * refreshes, the value in `app.env` is dead — so env-var storage is not merely
 * awkward, it is structurally impossible: the second container to refresh locks
 * the integration out until a human re-authorises. The refresh token has to
 * live in exactly one writable place, and refreshes have to be serialised.
 *
 * ## Why a lease and not a lock
 *
 * PostgREST runs each call in its own transaction, so `select ... for update`
 * cannot be held across the HTTP round trip to the provider. Instead a container
 * CLAIMS a short lease with a conditional update, does the refresh, writes the
 * new pair back and clears the lease. A container that loses the claim waits for
 * the winner's write rather than refreshing alongside it. A crashed winner is
 * recovered by lease expiry rather than by a human.
 *
 * Xero gives a consumed refresh token a 30-minute grace window, which makes a
 * genuinely raced refresh survivable. That is the safety net, not the mechanism.
 * Deliberately NOT used as the mechanism: a design that races routinely and
 * relies on grace only reveals itself on the day the grace does not cover it,
 * and the failure mode is a locked-out integration on the live books.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import type { LedgerProvider } from "./types";
import { LedgerError } from "./types";

/** Refresh this long before the provider's expiry. Mirrors `lib/zoho.ts`. */
const ACCESS_SAFETY_MS = 5 * 60 * 1000;

/**
 * How long a refresh claim is held. Short on purpose: a crashed claimant blocks
 * every other container until this elapses, and a refresh round trip is ~1s.
 */
const LEASE_TTL_SECONDS = 45;

/** How long a losing container waits for the winner's write before giving up. */
const LEASE_WAIT_MS = 10_000;
const LEASE_POLL_MS = 400;

export interface LedgerTokens {
  accessToken: string;
  /** Xero's tenant id; null for providers that identify the org another way. */
  tenantId: string | null;
}

/** What a provider hands back from a refresh. */
export interface RefreshedTokens {
  accessToken: string;
  /** Seconds until the ACCESS token expires (Xero: 1800). */
  expiresInSeconds: number;
  /** The NEW refresh token. For a rotating provider this differs every time. */
  refreshToken: string;
  tenantId?: string | null;
}

interface TokenRow {
  provider: string;
  refresh_token: string;
  access_token: string | null;
  access_expires_at: string | null;
  tenant_id: string | null;
  refresh_lease_until: string | null;
  refresh_lease_owner: string | null;
}

const COLUMNS =
  "provider, refresh_token, access_token, access_expires_at, tenant_id, refresh_lease_until, refresh_lease_owner";

function db() {
  return createAdminClient().from("ledger_tokens");
}

async function readRow(provider: LedgerProvider): Promise<TokenRow> {
  const { data, error } = await db().select(COLUMNS).eq("provider", provider).maybeSingle();
  if (error) {
    throw new LedgerError(`Could not read the ${provider} token row: ${error.message}`);
  }
  if (!data) {
    throw new LedgerError(
      `No ${provider} token row exists — run the one-off authorisation script before using the ${provider} adapter.`,
    );
  }
  return data as TokenRow;
}

/** A usable cached access token, or null when it is missing or too near expiry. */
function usable(row: TokenRow, nowMs: number): LedgerTokens | null {
  if (!row.access_token || !row.access_expires_at) return null;
  const expiresAt = Date.parse(row.access_expires_at);
  if (!Number.isFinite(expiresAt)) return null;
  if (expiresAt - ACCESS_SAFETY_MS <= nowMs) return null;
  return { accessToken: row.access_token, tenantId: row.tenant_id };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Return a usable access token for `provider`, refreshing through `refresh`
 * when the cached one is missing or near expiry.
 *
 * `refresh` is injected rather than imported so this module stays
 * provider-agnostic and unit-testable without any network or credentials — the
 * Xero adapter passes its own token endpoint call at gate 18.
 *
 * @param owner a stable-per-process id used to identify the lease holder in the
 *              row; only ever read by a human debugging a stuck lease.
 */
export async function getLedgerAccessToken(
  provider: LedgerProvider,
  refresh: (currentRefreshToken: string) => Promise<RefreshedTokens>,
  owner: string,
): Promise<LedgerTokens> {
  const row = await readRow(provider);
  const cached = usable(row, Date.now());
  if (cached) return cached;

  const leaseUntil = new Date(Date.now() + LEASE_TTL_SECONDS * 1000).toISOString();
  const nowIso = new Date().toISOString();

  // Claim: succeeds only when the lease is free or has expired. `.select()`
  // makes the update return the rows it actually changed, so an empty result
  // means another container holds it — never an error, and never a silent
  // assumption that we won.
  const { data: claimed, error: claimError } = await db()
    .update({ refresh_lease_until: leaseUntil, refresh_lease_owner: owner })
    .eq("provider", provider)
    .or(`refresh_lease_until.is.null,refresh_lease_until.lt.${nowIso}`)
    .select(COLUMNS);
  if (claimError) {
    throw new LedgerError(`Could not claim the ${provider} refresh lease: ${claimError.message}`);
  }

  const won = (claimed as TokenRow[] | null)?.[0];
  if (!won) return waitForWinner(provider);

  try {
    const next = await refresh(won.refresh_token);
    const expiresAt = new Date(Date.now() + next.expiresInSeconds * 1000).toISOString();
    const { error: writeError } = await db()
      .update({
        refresh_token: next.refreshToken,
        access_token: next.accessToken,
        access_expires_at: expiresAt,
        ...(next.tenantId !== undefined ? { tenant_id: next.tenantId } : {}),
        rotated_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        refresh_lease_until: null,
        refresh_lease_owner: null,
      })
      .eq("provider", provider);
    if (writeError) {
      // The provider has ALREADY rotated: the token we hold in memory is the
      // only valid one and we just failed to persist it. Say exactly that —
      // a generic "write failed" would read as retryable when it is not.
      throw new LedgerError(
        `The ${provider} refresh token rotated but could not be saved (${writeError.message}). ` +
          `The integration will need re-authorising.`,
      );
    }
    return { accessToken: next.accessToken, tenantId: next.tenantId ?? won.tenant_id };
  } catch (err) {
    // Release the lease so the next attempt is not blocked for the full TTL.
    // Best-effort: if this fails too, expiry still recovers it.
    await db()
      .update({ refresh_lease_until: null, refresh_lease_owner: null })
      .eq("provider", provider)
      .eq("refresh_lease_owner", owner);
    throw err;
  }
}

/**
 * Wait for the container holding the lease to publish a new access token.
 *
 * On timeout this THROWS rather than refreshing in parallel. A stampede of
 * simultaneous refreshes against a rotating provider is how an integration
 * locks itself out permanently; a failed page load is recoverable in one
 * refresh of the browser. The lease TTL is short, so the next call after it
 * expires simply claims and refreshes.
 */
async function waitForWinner(provider: LedgerProvider): Promise<LedgerTokens> {
  const deadline = Date.now() + LEASE_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(LEASE_POLL_MS);
    const row = await readRow(provider);
    const token = usable(row, Date.now());
    if (token) return token;
  }
  throw new LedgerError(
    `Timed out waiting for another process to refresh the ${provider} token. ` +
      `If this persists, check ledger_tokens.refresh_lease_owner for a stuck lease.`,
  );
}
