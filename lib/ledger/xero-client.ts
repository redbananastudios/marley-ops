/**
 * Xero HTTP + OAuth plumbing — SERVER ONLY.
 *
 * Everything provider-specific about *talking to* Xero lives here; the adapter
 * that implements `LedgerAdapter` sits on top and stays about invoices.
 *
 * Three properties this file exists to hold:
 *
 * 1. **The refresh token rotates on every use.** So it is never read from the
 *    environment and never held in a module variable — `token-store.ts` owns it,
 *    serialises refreshes with a lease, and is the only writer. `lib/zoho.ts`
 *    latches all of its auth state in module-level variables precisely because
 *    Zoho's refresh token never rotates; copying that shape here would lock the
 *    integration out the first time two containers refreshed at once.
 *
 * 2. **`tenantId` is re-read, never latched.** Xero's own guidance is to treat
 *    it as dynamic per request. It also genuinely changes: the Demo Company
 *    resets every 28 days and comes back with a new one, so a latched value is
 *    wrong on a schedule rather than by accident.
 *
 * 3. **A connection dies if it is left alone.** A Xero refresh token expires
 *    after 60 days. Rotation issues a fresh 60-day token on every use, so an
 *    integration that is *used* never expires — but one that is authorised and
 *    then left idle does, silently, and the first symptom is a failed cron pass
 *    two months later. That is a live risk for an environment authorised early
 *    and left on `LEDGER_PROVIDER=zoho` until cutover.
 *
 * 4. **Nothing here logs a secret or a token.** Errors carry the status and
 *    Xero's own message; the request bodies that contain credentials never reach
 *    a log line.
 */
import "server-only";

import { getLedgerAccessToken, type RefreshedTokens } from "./token-store";
import { LedgerError } from "./types";
import type { XeroOrgIdentity } from "./xero-guard";

/** Just enough of an environment to read credentials from. */
type EnvLike = Record<string, string | undefined>;

/**
 * Xero's OAuth 2.0 and API hosts.
 *
 * Deliberately one block, because these four strings are the part of the
 * integration most likely to be wrong from memory and the least likely to be
 * caught by a type. Confirmed against Xero's identity documentation rather than
 * the OpenAPI `_autodocs` summary, which has been wrong three separate times in
 * this project (it omits `AUTHORISED` from `Invoice.Status`, and it shows a
 * `/Contacts/ContactNumber/{ContactNumber}` path the yaml does not define).
 */
export const XERO = {
  authorize: "https://login.xero.com/identity/connect/authorize",
  token: "https://identity.xero.com/connect/token",
  connections: "https://api.xero.com/connections",
  api: "https://api.xero.com/api.xro/2.0",
} as const;

/**
 * The scopes this integration needs, and nothing more.
 *
 * **These are the GRANULAR scopes, not the broad ones.** Xero deprecated
 * `accounting.transactions` on 2 March 2026 and now assigns granular scopes to
 * every new Web app — so the string most sources (and most memories) reach for
 * is the wrong one to build with today. The apps behind these credentials were
 * created 2026-08-27, well after that change.
 *
 * The mapping Xero publishes: `accounting.transactions` split into
 * `accounting.invoices`, `accounting.payments`, `accounting.banktransactions`
 * and `accounting.manualjournals`. We need the first two and not the last two.
 *
 * What each one buys:
 *  - `offline_access` — the refresh token itself. Without it the response
 *    carries no `refresh_token` and the connection dies in thirty minutes, with
 *    every cron pass failing at once.
 *  - `accounting.contacts` — find and create the customer contact.
 *  - `accounting.invoices` — invoices, voiding, **credit notes**, and the
 *    invoice PDF. Credit notes living under invoices rather than payments is
 *    the non-obvious one.
 *  - `accounting.payments` — recording a payment against an invoice, and
 *    refunding a credit note.
 *  - `accounting.settings.read` — the organisation (which the live-write guard
 *    reads) and the chart of accounts. Read-only on purpose: nothing here ever
 *    edits an org's settings, and the write variant would let it.
 *
 * `openid profile email` are deliberately absent — we are not doing SSO, and an
 * id_token we never read is a credential we would be handling for no reason.
 *
 * If consent itself is REJECTED, suspect `accounting.settings.read` first and
 * widen it to `accounting.settings`. The narrower form is the least-privilege
 * choice and is what Xero documents as the minimum for `GET /Organisation`, but
 * the broad form is the one both sources agree is unchanged by the granular
 * rollout. Failing loudly at consent and widening one string is the cheap error;
 * granting settings-WRITE on a live accounting system to avoid the risk is the
 * expensive one, so the narrow form goes first.
 *
 * NOT YET PROVEN AGAINST A LIVE TOKEN: that `accounting.invoices` alone
 * authorises `GET /Invoices/{id}/pdf`. Xero's yaml still maps that operation to
 * the deprecated broad scope and no source states the granular equivalent, so
 * it is a chained inference. It fails loudly (401 insufficient_scope) rather
 * than silently, and the Demo Company smoke test is where it gets settled.
 */
export const XERO_SCOPES = [
  "offline_access",
  "accounting.contacts",
  "accounting.invoices",
  "accounting.payments",
  "accounting.settings.read",
] as const;

export interface XeroConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/**
 * Read the app credentials, or null when they are not configured.
 *
 * Null rather than a throw, so a build or a page that merely imports this module
 * while `LEDGER_PROVIDER=zoho` does not explode. The adapter turns null into a
 * clear `LedgerError` at the point of use.
 */
export function getXeroConfig(env: EnvLike = process.env): XeroConfig | null {
  const clientId = (env.XERO_CLIENT_ID ?? "").trim();
  const clientSecret = (env.XERO_CLIENT_SECRET ?? "").trim();
  const redirectUri = (env.XERO_REDIRECT_URI ?? "").trim();
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

function requireConfig(): XeroConfig {
  const config = getXeroConfig();
  if (!config) {
    throw new LedgerError(
      "Xero is not configured — XERO_CLIENT_ID, XERO_CLIENT_SECRET and XERO_REDIRECT_URI " +
        "must all be set. Staging uses the Demo Company app; the production pair belongs " +
        "only in prod's app.env.",
    );
  }
  return config;
}

/** HTTP Basic, the way Xero's token endpoint authenticates the app. */
function basicAuth({ clientId, clientSecret }: XeroConfig): string {
  return "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
}

/**
 * The consent URL a human opens once per organisation.
 *
 * `state` is round-tripped and MUST be checked on the way back — it is the only
 * thing standing between this endpoint and an attacker-chosen authorisation code
 * being exchanged under an admin's session.
 */
export function buildAuthoriseUrl(state: string, config: XeroConfig = requireConfig()): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: XERO_SCOPES.join(" "),
    state,
  });
  return `${XERO.authorize}?${params.toString()}`;
}

interface XeroTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function postToken(body: URLSearchParams): Promise<XeroTokenResponse> {
  const config = requireConfig();
  const res = await fetch(XERO.token, {
    method: "POST",
    headers: {
      Authorization: basicAuth(config),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  // Parsed before the status check: Xero puts the useful reason in the body,
  // and "400 Bad Request" alone tells an operator nothing.
  const json = (await res.json().catch(() => ({}))) as XeroTokenResponse;
  if (!res.ok || !json.access_token) {
    const why = json.error_description || json.error || `HTTP ${res.status}`;
    throw new LedgerError(`Xero token request failed: ${why}`, undefined, res.status);
  }
  return json;
}

/** Exchange the one-time authorisation code from the consent redirect. */
export async function exchangeAuthorisationCode(code: string): Promise<RefreshedTokens> {
  const config = requireConfig();
  const json = await postToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
    }),
  );
  return {
    accessToken: json.access_token!,
    refreshToken: json.refresh_token ?? "",
    expiresInSeconds: json.expires_in ?? 1800,
  };
}

/**
 * Spend the current refresh token for a new pair.
 *
 * Passed into `getLedgerAccessToken`, which serialises the call across
 * containers and persists what comes back. It also re-reads the tenant, because
 * a Demo Company reset changes it and a stale one addresses an organisation
 * that no longer exists.
 */
export async function refreshXeroTokens(currentRefreshToken: string): Promise<RefreshedTokens> {
  const json = await postToken(
    new URLSearchParams({ grant_type: "refresh_token", refresh_token: currentRefreshToken }),
  );
  const accessToken = json.access_token!;
  const refreshToken = json.refresh_token;
  if (!refreshToken) {
    // Xero rotates on every use. A response without a new refresh token means
    // the next refresh has nothing to spend, so say that now rather than
    // discovering it in 30 minutes on a cron pass.
    throw new LedgerError(
      "Xero returned no new refresh token — the rotation contract was not honoured, so " +
        "the connection will expire. Re-authorise with scripts/xero-authorise.mjs.",
    );
  }
  return {
    accessToken,
    refreshToken,
    expiresInSeconds: json.expires_in ?? 1800,
    tenantId: await firstTenantId(accessToken),
  };
}

/** Stable-per-process lease owner, for a human debugging a stuck refresh. */
const OWNER = `${process.pid}@${process.env.HOSTNAME ?? "marley-ops"}`;

/** A usable access token plus the tenant it addresses. */
export async function xeroAuth(): Promise<{ accessToken: string; tenantId: string }> {
  const { accessToken, tenantId } = await getLedgerAccessToken("xero", refreshXeroTokens, OWNER);
  if (!tenantId) {
    throw new LedgerError(
      "No Xero tenant is recorded for this connection. If the Demo Company was reset, " +
        "re-authorise with scripts/xero-authorise.mjs.",
    );
  }
  return { accessToken, tenantId };
}

interface XeroConnection {
  tenantId?: string;
  tenantType?: string;
  tenantName?: string;
}

/** The organisations this token may address. */
export async function listConnections(accessToken: string): Promise<XeroConnection[]> {
  const res = await fetch(XERO.connections, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new LedgerError(`Xero connections lookup failed (HTTP ${res.status})`, undefined, res.status);
  }
  return (await res.json()) as XeroConnection[];
}

/**
 * The tenant to address.
 *
 * A connection carrying more than one organisation is refused rather than
 * resolved by taking the first row. Picking one by position is a guess about
 * which company's books to write to, and this repo has already been bitten by
 * `.[0]` on a ranked lookup (marley-ops `875eec3`). Ambiguity yields nothing.
 */
async function firstTenantId(accessToken: string): Promise<string | null> {
  const orgs = (await listConnections(accessToken)).filter((c) => c.tenantType === "ORGANISATION");
  if (orgs.length === 0) return null;
  if (orgs.length > 1) {
    throw new LedgerError(
      `This Xero connection grants access to ${orgs.length} organisations ` +
        `(${orgs.map((o) => o.tenantName ?? o.tenantId).join(", ")}). Refusing to guess which ` +
        `set of books to use — re-authorise and grant exactly one.`,
    );
  }
  return orgs[0].tenantId ?? null;
}

/**
 * One authenticated Accounting API call.
 *
 * @param accept override for the PDF path, which asks for `application/pdf` on
 *               the same URL that otherwise returns JSON.
 */
export async function xeroFetch(
  path: string,
  init: RequestInit = {},
  accept = "application/json",
): Promise<Response> {
  const { accessToken, tenantId } = await xeroAuth();
  const res = await fetch(`${XERO.api}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${accessToken}`,
      "xero-tenant-id": tenantId,
      Accept: accept,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  return res;
}

/**
 * The connected organisation's identity — the input to the live-write guard.
 *
 * Returns `class: null` rather than throwing when the read fails, because the
 * guard treats an unreadable class as LIVE. A network blip must not be able to
 * turn into permission to write.
 */
export async function readOrganisation(): Promise<XeroOrgIdentity & { scopeDenied?: boolean }> {
  try {
    const res = await xeroFetch("/Organisation");
    if (!res.ok) {
      // A 401/403 here is a SCOPE problem, not a safety one, and the two look
      // identical downstream: the guard sees a null class, refuses every write,
      // and the message talks about the cutover while the real cause is a
      // missing `accounting.settings.read`. Flagged so the caller can say which.
      return { class: null, scopeDenied: res.status === 401 || res.status === 403 };
    }
    // Xero returns an ARRAY with one element, not an object. An empty array is
    // "could not determine", which the guard treats as live.
    const json = (await res.json()) as {
      Organisations?: { Class?: string; Name?: string; IsDemoCompany?: boolean }[];
    };
    const org = json.Organisations?.[0];
    if (!org) return { class: null };
    return {
      class: org.Class ?? null,
      // Undefined stays undefined rather than collapsing to false — the guard
      // distinguishes "absent" from "explicitly not a demo", and only the
      // second one vetoes.
      isDemoCompany: org.IsDemoCompany,
      name: org.Name ?? null,
    };
  } catch {
    return { class: null };
  }
}
