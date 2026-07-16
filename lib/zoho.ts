/**
 * Zoho Invoice client (EU DC) — SERVER ONLY. Talks to Connor's LIVE Marley Moves
 * Ltd org, so every write here lands in the real books.
 *
 * Plan constraints discovered 2026-07-09 against the live org:
 *  - Retainer invoices are NOT on Connor's plan → the deposit is a real invoice
 *    (reference `<quoteRef>-DEP`), the pre-move balance a second one (`-BAL`).
 *  - VAT can't be enabled in Zoho without the registration number (pending from
 *    Connor) → invoices go out as single VAT-inclusive lines until a 20% rate
 *    exists in the org, at which point lines auto-itemise ex-VAT + VAT.
 *  - No card gateway is active yet → the hosted invoice_url still works as a
 *    "view your invoice" page; card copy is only shown once a gateway is live.
 */

const TOKEN_SAFETY_MS = 5 * 60 * 1000; // refresh 5 min before Zoho's 1h expiry

export class ZohoError extends Error {
  constructor(
    message: string,
    public zohoCode?: number,
    public httpStatus?: number,
  ) {
    super(message);
    this.name = "ZohoError";
  }
}

function cfg() {
  const c = {
    clientId: process.env.ZOHO_CLIENT_ID,
    clientSecret: process.env.ZOHO_CLIENT_SECRET,
    refreshToken: process.env.ZOHO_REFRESH_TOKEN,
    orgId: process.env.ZOHO_ORG_ID,
    accountsUrl: process.env.ZOHO_ACCOUNTS_URL || "https://accounts.zoho.eu",
    apiUrl: process.env.ZOHO_API_URL || "https://www.zohoapis.eu",
  };
  if (!c.clientId || !c.clientSecret || !c.refreshToken || !c.orgId) {
    throw new ZohoError("Zoho credentials not configured (ZOHO_* env vars)");
  }
  return c as Record<keyof typeof c, string>;
}

let tokenCache: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  const c = cfg();
  const res = await fetch(`${c.accountsUrl}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: c.refreshToken,
      client_id: c.clientId,
      client_secret: c.clientSecret,
      grant_type: "refresh_token",
    }),
  });
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
  };
  if (!res.ok || !json.access_token) {
    throw new ZohoError(`Zoho token refresh failed: ${json.error ?? res.status}`, undefined, res.status);
  }
  tokenCache = {
    token: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 - TOKEN_SAFETY_MS,
  };
  return tokenCache.token;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function zoho<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const c = cfg();
  const token = await getAccessToken();
  const res = await fetch(`${c.apiUrl}/invoice/v3${path}`, {
    method,
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      "X-com-zoho-invoice-organizationid": c.orgId,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || (typeof json.code === "number" && json.code !== 0)) {
    throw new ZohoError(json.message || `Zoho error ${res.status}`, json.code, res.status);
  }
  return json as T;
}

/* ------------------------------------------------------------- contacts */

/** Find a contact by (exact, case-insensitive) email, else create one. Returns contact_id. */
export async function findOrCreateContact(input: {
  name: string;
  email?: string | null;
  phone?: string | null;
}): Promise<string> {
  const email = input.email?.trim().toLowerCase() || null;
  if (email) {
    const found = await zoho("GET", `/contacts?email=${encodeURIComponent(email)}`);
    const match = (found.contacts ?? []).find(
      (c: any) => (c.email ?? "").toLowerCase() === email && c.contact_type !== "vendor",
    );
    if (match) return match.contact_id as string;
  }
  const [first, ...rest] = (input.name || "Customer").trim().split(/\s+/);
  const created = await zoho("POST", "/contacts", {
    contact_name: input.name || email || "Customer",
    contact_persons: [
      {
        first_name: first,
        last_name: rest.join(" ") || ".",
        email: email ?? undefined,
        phone: input.phone ?? undefined,
        is_primary_contact: true,
      },
    ],
  });
  return created.contact.contact_id as string;
}

/* ------------------------------------------------------------- taxes / gateway */

let vatTaxCache: { id: string | null; at: number } | null = null;

/** The org's 20% VAT rate, if one exists (null until Connor's VAT number lands
 *  and VAT is enabled in Zoho). Cached 1h; invoices self-upgrade to itemised
 *  VAT the hour a rate appears. */
export async function getVatTaxId(): Promise<string | null> {
  if (vatTaxCache && Date.now() - vatTaxCache.at < 3600_000) return vatTaxCache.id;
  let id: string | null = null;
  try {
    const res = await zoho("GET", "/settings/taxes");
    const t = (res.taxes ?? []).find((x: any) => Number(x.tax_percentage) === 20);
    id = t?.tax_id ?? null;
  } catch {
    id = null; // tax module disabled → inclusive single-line invoices
  }
  vatTaxCache = { id, at: Date.now() };
  return id;
}

let gatewayCache: { active: boolean; at: number } | null = null;

/** True once any online payment gateway is connected in Zoho settings. */
export async function isPaymentGatewayActive(): Promise<boolean> {
  if (gatewayCache && Date.now() - gatewayCache.at < 3600_000) return gatewayCache.active;
  let active = false;
  try {
    const res = await zoho("GET", "/settings/paymentgateways");
    active =
      (res.payment_gateways ?? []).length > 0 ||
      (res.payment_gateway_details ?? []).some((d: any) => d.status === "active");
  } catch {
    active = false;
  }
  gatewayCache = { active, at: Date.now() };
  return active;
}

/* ------------------------------------------------------------- invoices */

export interface ZohoInvoiceRef {
  invoiceId: string;
  invoiceNumber: string;
  invoiceUrl: string | null;
}

export interface ZohoInvoiceStatus extends ZohoInvoiceRef {
  status: string; // draft | sent | paid | partially_paid | overdue | void
  total: number;
  balance: number;
}

/** Adopt an existing invoice by our reference number — the belt-and-braces half
 *  of the never-create-twice contract (covers a crash between Zoho-create and
 *  the DB write-back). */
export async function findInvoiceByReference(reference: string): Promise<ZohoInvoiceRef | null> {
  const res = await zoho("GET", `/invoices?reference_number=${encodeURIComponent(reference)}`);
  const inv = (res.invoices ?? []).find((i: any) => i.status !== "void");
  if (!inv) return null;
  return {
    invoiceId: inv.invoice_id,
    invoiceNumber: inv.invoice_number,
    invoiceUrl: (inv.invoice_url as string | undefined)?.trim() || null,
  };
}

/**
 * Create an invoice (VAT-inclusive amount), mark it sent (required for the
 * hosted customer URL; Zoho does NOT email the customer — all comms stay in
 * Resend), and return its id/number/url.
 */
export async function createInvoice(input: {
  customerId: string;
  reference: string;
  description: string;
  /** Customer-facing total, VAT-inclusive. */
  amount: number;
  notes?: string;
  /** Balance invoices are BACS/cash only (card fees too high at those values —
   *  Peter, 2026-07-09): strip online gateways so even the hosted page can't
   *  take a card once Stripe is connected. Deposit invoices keep the default. */
  disableOnlinePayments?: boolean;
}): Promise<ZohoInvoiceRef> {
  const taxId = await getVatTaxId();
  const line: Record<string, unknown> = {
    description: input.description,
    rate: Math.round(input.amount * 100) / 100,
    quantity: 1,
  };
  if (taxId) line.tax_id = taxId;

  const created = await zoho("POST", "/invoices", {
    customer_id: input.customerId,
    reference_number: input.reference,
    ...(taxId ? { is_inclusive_tax: true } : {}),
    ...(input.disableOnlinePayments ? { payment_options: { payment_gateways: [] } } : {}),
    line_items: [line],
    notes: input.notes,
  });
  const id = created.invoice.invoice_id as string;
  await zoho("POST", `/invoices/${id}/status/sent`);
  const full = await zoho("GET", `/invoices/${id}`);
  return {
    invoiceId: id,
    invoiceNumber: full.invoice.invoice_number,
    invoiceUrl: (full.invoice.invoice_url as string | undefined)?.trim() || null,
  };
}

export interface ZohoInvoiceListItem {
  invoiceId: string;
  invoiceNumber: string;
  reference: string;
  customerName: string;
  /** Invoice date (yyyy-mm-dd) — the "raised on" day the Finance page groups by. */
  date: string;
  status: string; // draft | sent | viewed | paid | partially_paid | overdue | void
  /** Gross (VAT-inclusive) total. */
  total: number;
  /** Unpaid remainder. */
  balance: number;
}

/**
 * Invoices from the org's books — includes ones raised by hand in Zoho, not
 * just the panel's (that's the point: the Finance page reports the BUSINESS,
 * not the app). Filter by invoice-date range and/or Zoho's status buckets
 * (Status.Unpaid = sent + viewed + overdue + partially paid). Pages through
 * the list API; capped generously (2000 rows) as a runaway guard.
 */
export interface ZohoInvoiceList {
  invoices: ZohoInvoiceListItem[];
  /** True when the 2,000-row runaway cap cut the result short — money figures
   *  built from a truncated list must say so rather than silently understate. */
  truncated: boolean;
}

export async function listInvoices(input: {
  dateStart?: string;
  dateEnd?: string;
  filterBy?: "Status.Unpaid" | "Status.All";
}): Promise<ZohoInvoiceList> {
  const out: ZohoInvoiceListItem[] = [];
  let truncated = false;
  for (let page = 1; page <= 10; page++) {
    const params = new URLSearchParams({
      page: String(page),
      per_page: "200",
      sort_column: "date",
      sort_order: "D",
    });
    if (input.dateStart) params.set("date_start", input.dateStart);
    if (input.dateEnd) params.set("date_end", input.dateEnd);
    if (input.filterBy) params.set("filter_by", input.filterBy);
    const res = await zoho("GET", `/invoices?${params.toString()}`);
    for (const i of res.invoices ?? []) {
      out.push({
        invoiceId: i.invoice_id as string,
        invoiceNumber: (i.invoice_number as string) ?? "",
        reference: (i.reference_number as string) ?? "",
        customerName: (i.customer_name as string) ?? "",
        date: (i.date as string) ?? "",
        status: (i.status as string) ?? "",
        total: Number(i.total ?? 0),
        balance: Number(i.balance ?? 0),
      });
    }
    if (!res.page_context?.has_more_page) break;
    if (page === 10) truncated = true; // cap hit with more pages remaining
  }
  return { invoices: out, truncated };
}

/** Zoho web-app deep link for an invoice (the OFFICE view, not the customer URL). */
export function zohoInvoiceAppUrl(invoiceId: string): string {
  const orgId = process.env.ZOHO_ORG_ID ?? "";
  return `https://invoice.zoho.eu/app/${orgId}#/invoices/${invoiceId}`;
}

export async function getInvoiceStatus(invoiceId: string): Promise<ZohoInvoiceStatus> {
  const res = await zoho("GET", `/invoices/${invoiceId}`);
  const i = res.invoice;
  return {
    invoiceId: i.invoice_id,
    invoiceNumber: i.invoice_number,
    invoiceUrl: (i.invoice_url as string | undefined)?.trim() || null,
    status: i.status,
    total: Number(i.total ?? 0),
    balance: Number(i.balance ?? 0),
  };
}

/** Record a customer payment applied to one invoice (e.g. a BACS deposit). */
export async function recordInvoicePayment(input: {
  customerId: string;
  invoiceId: string;
  amount: number;
  mode: "banktransfer" | "cash" | "creditcard";
  reference?: string;
  /** yyyy-mm-dd (UK day); defaults to today. */
  date?: string;
}): Promise<string> {
  const res = await zoho("POST", "/customerpayments", {
    customer_id: input.customerId,
    payment_mode: input.mode,
    amount: Math.round(input.amount * 100) / 100,
    date: input.date ?? new Date().toISOString().slice(0, 10),
    reference_number: input.reference,
    invoices: [{ invoice_id: input.invoiceId, amount_applied: Math.round(input.amount * 100) / 100 }],
  });
  return res.payment.payment_id as string;
}

/** The customer-facing invoice PDF (Zoho's own VAT document) as base64. */
export async function getInvoicePdfBase64(invoiceId: string): Promise<string> {
  const c = cfg();
  const token = await getAccessToken();
  const res = await fetch(`${c.apiUrl}/invoice/v3/invoices/${invoiceId}?accept=pdf`, {
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      "X-com-zoho-invoice-organizationid": c.orgId,
    },
  });
  if (!res.ok) throw new ZohoError(`Invoice PDF fetch failed (${res.status})`, undefined, res.status);
  return Buffer.from(await res.arrayBuffer()).toString("base64");
}

/**
 * Void an UNPAID invoice — the app-flow reversal used when a quote is superseded
 * (re-quote after acceptance) or a lead cancels before paying. Void only, never
 * delete: the voided document stays on Connor's books for the audit trail. Paid
 * invoices are never voided from code — refunds/credit notes are a human call.
 */
export async function voidInvoice(invoiceId: string): Promise<void> {
  const status = await getInvoiceStatus(invoiceId);
  if (status.status === "void") return; // already done
  if (status.status === "paid" || status.balance < status.total) {
    throw new ZohoError(`Refusing to void ${status.invoiceNumber}: payment already applied`);
  }
  await zoho("POST", `/invoices/${invoiceId}/status/void`);
}

/* ------------------------------------------------------------- cleanup (test hygiene) */

/** Void + delete an invoice — used only by test-data cleanup, never in the app flow. */
export async function voidAndDeleteInvoice(invoiceId: string): Promise<void> {
  try {
    await zoho("POST", `/invoices/${invoiceId}/status/void`);
  } catch {
    /* drafts can't be voided — deletable directly */
  }
  await zoho("DELETE", `/invoices/${invoiceId}`);
}

export async function deletePayment(paymentId: string): Promise<void> {
  await zoho("DELETE", `/customerpayments/${paymentId}`);
}

export async function deleteContact(contactId: string): Promise<void> {
  await zoho("DELETE", `/contacts/${contactId}`);
}
