/**
 * Read-only assertions against the STAGING Zoho Invoice org (Demo Removals), for
 * the money-path E2E. The strongest possible verification of a money invariant is
 * the real books it lands in — so these specs drive the UI and then check what
 * actually exists in Zoho.
 *
 * HARD SAFETY: refuses to talk to the live org id, and requires a numeric staging
 * ZOHO_ORG_ID (the E2E dummy "E2E-STAGING-PENDING" is non-numeric → throws). It
 * only reads/lists; the one write path (cleanup) voids+deletes E2E-prefixed test
 * invoices and is never called against anything but staging.
 */

const LIVE_ORG_ID = "20106952968"; // Connor's real Marley Moves Ltd books — never here.

function env() {
  const org = process.env.ZOHO_ORG_ID ?? "";
  if (!/^\d+$/.test(org)) {
    throw new Error(`Zoho E2E: ZOHO_ORG_ID must be a numeric STAGING org id (got "${org}").`);
  }
  if (org === LIVE_ORG_ID) throw new Error("Zoho E2E: refusing to touch the LIVE org.");
  const clientId = process.env.ZOHO_CLIENT_ID;
  const clientSecret = process.env.ZOHO_CLIENT_SECRET;
  const refreshToken = process.env.ZOHO_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) throw new Error("Zoho E2E: ZOHO_* creds missing.");
  return {
    org,
    clientId,
    clientSecret,
    refreshToken,
    accounts: process.env.ZOHO_ACCOUNTS_URL || "https://accounts.zoho.eu",
    api: process.env.ZOHO_API_URL || "https://www.zohoapis.eu",
  };
}

let cached: { token: string; at: number } | null = null;

async function accessToken(e: ReturnType<typeof env>): Promise<string> {
  if (cached && Date.now() - cached.at < 50 * 60 * 1000) return cached.token;
  const res = await fetch(`${e.accounts}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: e.refreshToken,
      client_id: e.clientId,
      client_secret: e.clientSecret,
      grant_type: "refresh_token",
    }),
  });
  const j = (await res.json().catch(() => ({}))) as { access_token?: string };
  if (!res.ok || !j.access_token) throw new Error(`Zoho E2E: token refresh failed (${res.status}).`);
  cached = { token: j.access_token, at: Date.now() };
  return j.access_token;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function zget(e: ReturnType<typeof env>, tok: string, path: string): Promise<any> {
  const res = await fetch(`${e.api}/invoice/v3${path}`, {
    headers: { Authorization: `Zoho-oauthtoken ${tok}`, "X-com-zoho-invoice-organizationid": e.org },
  });
  return res.json().catch(() => ({}));
}

export interface StagingInvoice {
  invoiceId: string;
  ref: string;
  total: number;
  taxTotal: number;
  subTotal: number;
  status: string;
}

/** Every staging invoice whose reference starts with `prefix` (e.g. a quote ref),
 *  with the VAT breakdown pulled from each invoice's detail. */
export async function stagingInvoicesByRefPrefix(prefix: string): Promise<StagingInvoice[]> {
  const e = env();
  const tok = await accessToken(e);
  const list = await zget(e, tok, `/invoices?per_page=200`);
  const matches = (list.invoices ?? []).filter((i: any) =>
    String(i.reference_number ?? "").startsWith(prefix),
  );
  const out: StagingInvoice[] = [];
  for (const m of matches) {
    const d = await zget(e, tok, `/invoices/${m.invoice_id}`);
    const inv = d.invoice ?? {};
    out.push({
      invoiceId: m.invoice_id,
      ref: inv.reference_number ?? "",
      total: Number(inv.total ?? 0),
      taxTotal: Number(inv.tax_total ?? 0),
      subTotal: Number(inv.sub_total ?? 0),
      status: inv.status ?? "",
    });
  }
  return out;
}

/** Void + delete every E2E-prefixed invoice in staging (teardown only). Zoho
 *  won't delete a sent invoice, so void first — and it won't void a PAID one
 *  either, so un-apply its payment first. Missing this leaves a stale paid test
 *  invoice in the org that the accept flow's reference-orphan adoption then
 *  latches onto on the NEXT run (it shadowed the £100 deposit assertion with a
 *  £15 leftover). Returns how many were removed. */
export async function purgeStagingInvoices(prefix = "E2E-"): Promise<number> {
  const e = env();
  const tok = await accessToken(e);
  const headers = {
    Authorization: `Zoho-oauthtoken ${tok}`,
    "X-com-zoho-invoice-organizationid": e.org,
  };
  // A paid invoice can neither be voided nor deleted until its payment is
  // removed — and Zoho does NOT reliably surface that payment on the invoice
  // detail (the `payments` array came back empty for a genuinely-paid one). This
  // is a dedicated staging org, so any customer payment carrying the test prefix
  // is ours: sweep them first. Reference is the quote ref (e.g. "E2E-SENT-001"),
  // which shares the same prefix as the invoices ("E2E-SENT-001-DEP").
  const pays = await zget(e, tok, `/customerpayments?per_page=200`);
  for (const p of pays.customerpayments ?? []) {
    if (!p.payment_id || !String(p.reference_number ?? "").startsWith(prefix)) continue;
    await fetch(`${e.api}/invoice/v3/customerpayments/${p.payment_id}`, {
      method: "DELETE",
      headers,
    }).catch(() => {});
  }

  const list = await zget(e, tok, `/invoices?per_page=200`);
  const matches = (list.invoices ?? []).filter((i: any) =>
    String(i.reference_number ?? "").startsWith(prefix),
  );
  let n = 0;
  for (const m of matches) {
    await fetch(`${e.api}/invoice/v3/invoices/${m.invoice_id}/status/void`, {
      method: "POST",
      headers,
    }).catch(() => {});
    const del = await fetch(`${e.api}/invoice/v3/invoices/${m.invoice_id}`, {
      method: "DELETE",
      headers,
    }).catch(() => null);
    if (del?.ok) n++;
  }
  return n;
}
