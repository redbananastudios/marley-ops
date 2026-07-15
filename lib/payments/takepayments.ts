import { createHash, timingSafeEqual } from "crypto";

/**
 * takepayments online gateway protocol (white-labelled Cardstream family).
 * PRD: docs/takepayments-card-payments-prd.md · field reference:
 * O:\RBS-OS\references\takepayments-api.md (gateway integration guide v3.02).
 *
 * MONEY-CRITICAL: the signing serialisation below is a verbatim port of the
 * official takepayments Node SDK's `gateway.js` (PHP-compatible key sort,
 * RFC1738 encoding with `*`→%2A and space→+, CR/LF→%0A normalisation, the
 * threeDSResponse quirk). Golden tests in tests/lib/payments/takepayments.test.ts
 * pin our output byte-for-byte to signatures produced by the official SDK —
 * do NOT "tidy" any of it without regenerating those fixtures.
 *
 * Hard policy (Peter, 2026-07-15): one-off SALE only. No recurring agreements,
 * no Credentials-on-File — `rtAgreementType` must never appear in a request.
 */

export type GatewayFields = Record<string, string | number>;

/** Gateway responses arrive as flat string maps (bracket keys stay literal). */
export type GatewayResponse = Record<string, string>;

export const RC_SUCCESS = 0;

export interface TakepaymentsConfig {
  merchantId: string;
  signatureKey: string;
  hostedUrl: string;
  directUrl: string;
  testMode: boolean;
}

/** Config lives server-side only (app.env / .env.local — never NEXT_PUBLIC). */
export function getTakepaymentsConfig(): TakepaymentsConfig | null {
  const merchantId = process.env.TAKEPAYMENTS_MERCHANT_ID;
  const signatureKey = process.env.TAKEPAYMENTS_SIGNATURE_KEY;
  if (!merchantId || !signatureKey) return null;
  return {
    merchantId,
    signatureKey,
    hostedUrl: process.env.TAKEPAYMENTS_HOSTED_URL || "https://gw1.tponlinepayments.com/paymentform/",
    directUrl: process.env.TAKEPAYMENTS_DIRECT_URL || "https://gw1.tponlinepayments.com/direct/",
    testMode: process.env.TAKEPAYMENTS_TEST_MODE === "true",
  };
}

/* ------------------------------------------------------------- signing */

/**
 * PHP urlencode / http_build_query (RFC1738) equivalent, matching the SDK's
 * `http-build-query` package output: space→'+', `!'()*`→%XX, `~` literal.
 */
function phpUrlEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (c) => "%" + c.codePointAt(0)!.toString(16).toUpperCase())
    .replace(/%20/g, "+");
}

/**
 * PHP-compatible key sort, ported verbatim from the SDK (incl. the `[`-sorts-
 * as-`0` swap and the stop-at-bracket behaviour — PHP doesn't sort nested keys).
 */
export function phpCompatibleSort(a: string, b: string): number {
  let pos = 0;
  let rtn: number;
  let foundSqr = false;
  const ZERO = "0".codePointAt(0)!;
  const SQR = "[".codePointAt(0)!;

  do {
    let achr = a.codePointAt(pos);
    let bchr = b.codePointAt(pos);
    if (achr === undefined) return -1;
    if (bchr === undefined) return 1;
    if (achr === SQR) {
      achr = ZERO;
      foundSqr = true;
    }
    if (bchr === SQR) {
      bchr = ZERO;
      foundSqr = true;
    }
    rtn = achr - bchr;
    pos++;
  } while (rtn === 0 && foundSqr === false);

  return rtn;
}

function fieldPairs(name: string, value: unknown, out: string[]): void {
  if (value !== null && typeof value === "object") {
    // Nested records keep insertion order (PHP doesn't sort sub-fields).
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      fieldPairs(`${name}[${k}]`, v, out);
    }
    return;
  }
  out.push(`${phpUrlEncode(name)}=${phpUrlEncode(String(value))}`);
}

/** The exact byte string the SHA-512 runs over (exported for the golden tests). */
export function buildSigningBody(data: GatewayFields | GatewayResponse): string {
  const keys = Object.keys(data).sort(phpCompatibleSort);
  const pairs: string[] = [];
  for (const key of keys) fieldPairs(key, (data as Record<string, unknown>)[key], pairs);
  let body = pairs.join("&");
  // SDK quirks, preserved verbatim: legacy threeDSResponse form + newline
  // normalisation so PHP/browser CRLF differences can't break the hash.
  body = body.replace("&threeDSResponse=", "&threeDSResponse");
  body = body.replace(/%0D%0A|%0A%0D|%0D/gi, "%0A");
  return body;
}

/** SHA-512 hex over serialised fields + secret — the gateway `signature`. */
export function signFields(data: GatewayFields | GatewayResponse, secret: string): string {
  return createHash("sha512").update(buildSigningBody(data)).update(secret).digest("hex");
}

/**
 * Verify a signed gateway message (browser return POST or server callback).
 * Handles the partial form `hash|field1,field2,…` — only the listed fields
 * are signed. Returns the signature-stripped fields on success, null on any
 * mismatch (treat as tampered — never act on it).
 */
export function verifySignedResponse(
  fields: GatewayResponse,
  secret: string,
): GatewayResponse | null {
  const { signature, ...rest } = fields;
  if (!signature) return null;

  let expected = signature;
  let toSign: GatewayResponse = rest;
  const pipe = signature.indexOf("|");
  if (pipe !== -1) {
    expected = signature.slice(0, pipe);
    const listed = signature.slice(pipe + 1).split(",");
    toSign = {};
    for (const key of listed) {
      if (key in rest) toSign[key] = rest[key];
    }
  }

  const actual = signFields(toSign, secret);
  const a = Buffer.from(actual, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return rest;
}

/* ------------------------------------------------------------- requests */

export interface HostedSaleInput {
  config: TakepaymentsConfig;
  /** Minor units (pence). Signed into the form — the customer cannot alter it. */
  amountPence: number;
  /** Our card_payments row id — the gateway echoes it back on every message. */
  transactionUnique: string;
  orderRef: string;
  redirectUrl: string;
  callbackUrl: string;
  customerName?: string | null;
  customerEmail?: string | null;
}

/**
 * Build the signed field set for a hosted SALE. Rendered as hidden inputs in a
 * form the customer's browser auto-submits to the HPP. One-off ECOM payment:
 * type=1, no agreement/CoF fields, formResponsive for the phone-first HPP.
 */
export function buildHostedSaleFields(input: HostedSaleInput): {
  url: string;
  fields: Record<string, string>;
} {
  const data: GatewayFields = {
    merchantID: input.config.merchantId,
    action: "SALE",
    type: 1,
    amount: Math.round(input.amountPence),
    currencyCode: 826,
    countryCode: 826,
    transactionUnique: input.transactionUnique,
    orderRef: input.orderRef,
    redirectURL: input.redirectUrl,
    callbackURL: input.callbackUrl,
    formResponsive: "Y",
  };
  if (input.customerName) data.customerName = input.customerName;
  if (input.customerEmail) data.customerEmail = input.customerEmail;

  const signature = signFields(data, input.config.signatureKey);
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) fields[k] = String(v);
  fields.signature = signature;
  return { url: input.config.hostedUrl, fields };
}

/** Parse an x-www-form-urlencoded gateway message into a flat string map. */
export function parseGatewayBody(body: string): GatewayResponse {
  const out: GatewayResponse = {};
  for (const [k, v] of new URLSearchParams(body)) out[k] = v;
  return out;
}

/**
 * Direct API request (management actions: QUERY, REFUND_SALE, CANCEL).
 * Signs the request, POSTs it, verifies the response signature. Throws on
 * transport failure or a tampered response; gateway-level declines come back
 * as fields (check responseCode).
 */
export async function directRequest(
  config: TakepaymentsConfig,
  request: GatewayFields,
): Promise<GatewayResponse> {
  const data: GatewayFields = { merchantID: config.merchantId, ...request };
  const signature = signFields(data, config.signatureKey);

  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(data)) body.set(k, String(v));
  body.set("signature", signature);

  const res = await fetch(config.directUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`takepayments direct request failed: HTTP ${res.status}`);
  }
  const fields = parseGatewayBody(text);
  if (!("responseCode" in fields)) {
    throw new Error("takepayments direct request: malformed response");
  }
  const verified = verifySignedResponse(fields, config.signatureKey);
  if (!verified) {
    throw new Error("takepayments direct request: response signature mismatch");
  }
  return verified;
}
