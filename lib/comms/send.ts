/** Low-level senders. SERVER ONLY. A COMMS_DRYRUN=true env short-circuits to a simulated
 *  success so the panel's send + duplicate-guard flow is testable locally without real sends. */

import { createHash } from "node:crypto";

export interface SendResult {
  ok: boolean;
  providerId?: string;
  error?: string;
  /** True when COMMS_DRYRUN short-circuited without contacting a provider. */
  simulated?: boolean;
  /** The request left this process but the transport outcome is unknowable. */
  outcomeUnknown?: boolean;
}

const DRYRUN = process.env.COMMS_DRYRUN === "true";

export interface SendEmailInput {
  to: string;
  subject: string;
  /** Inline HTML body — ignored when `template` is set (Resend forbids both). */
  html?: string;
  /** Send via a PUBLISHED Resend template (id or alias) + its variables.
   *  Templates are managed in the Resend dashboard/API — see scripts/create-resend-templates.mjs. */
  template?: { id: string; variables?: Record<string, string | number> };
  attachments?: { filename: string; content: string }[]; // content = base64
  /** Override Reply-To (default hello@) — chase emails use the per-lead
   *  q-<token>@reply.marleymoves.co.uk address so replies route back in. */
  replyTo?: string;
  /** Override the display sender (must stay on the verified domain) — the
   *  personal chase emails send as Peter Farrell. */
  from?: string;
  /** Stable logical-send key. Resend retains these for 24 hours. */
  idempotencyKey?: string;
}

function emailRequestPayload(input: SendEmailInput) {
  return {
    from: input.from || process.env.RESEND_FROM_EMAIL || "Marley Moves <hello@marleymoves.co.uk>",
    to: [input.to],
    reply_to: input.replyTo || "hello@marleymoves.co.uk",
    subject: input.subject,
    ...(input.template ? { template: input.template } : { html: input.html }),
    attachments: input.attachments,
  };
}

/** Hash of the exact JSON payload sent to Resend (excluding the retry key). */
export function emailPayloadHash(input: SendEmailInput): string {
  return createHash("sha256").update(JSON.stringify(emailRequestPayload(input))).digest("hex");
}

export async function sendEmail(input: SendEmailInput): Promise<SendResult> {
  if (DRYRUN) return { ok: true, providerId: `dryrun-email-${Date.now()}`, simulated: true };
  const key = process.env.MARLEY_RESEND_API_KEY || process.env.RESEND_API_KEY;
  if (!key) return { ok: false, error: "Resend API key not configured" };
  if (!input.template && !input.html) return { ok: false, error: "No email body (html or template) given" };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : {}),
      },
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify(emailRequestPayload(input)),
    });
    const json = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!res.ok) return {
      ok: false,
      error: json.message || `Resend error ${res.status}`,
      outcomeUnknown: res.status === 408 || res.status === 409 || res.status >= 500,
    };
    return { ok: true, providerId: json.id };
  } catch (err) {
    // A retry with the same Idempotency-Key is safe even if the response was lost.
    return { ok: false, error: err instanceof Error ? err.message : "Email send failed", outcomeUnknown: true };
  }
}

export async function sendSms(input: { to: string; body: string }): Promise<SendResult> {
  if (DRYRUN) return { ok: true, providerId: `dryrun-sms-${Date.now()}`, simulated: true };
  const key = process.env.WEBEX_API_KEY;
  const sender = process.env.WEBEX_SMS_SENDER_MARLEY_MOVES || process.env.WEBEX_SMS_SENDER;
  if (!key) return { ok: false, error: "WebEx API key not configured" };
  if (!sender) return { ok: false, error: "WebEx sender ID not configured" };
  // WebEx wants E.164 — leads often carry the raw UK "07…" form.
  let to = input.to.replace(/[\s()-]/g, "");
  if (/^0\d{10}$/.test(to)) to = "+44" + to.slice(1);
  try {
    // Payload shape per the live site's proven sender (site/web/lib/sms/webex.ts):
    // the message field is `message_body` (NOT `body`) and the transaction id
    // comes back inside `messages[0]`.
    const res = await fetch("https://api.webexinteract.com/v1/sms", {
      method: "POST",
      headers: { "X-AUTH-KEY": key, "Content-Type": "application/json", Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({ from: sender, message_body: input.body, to: [{ phone: [to] }] }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      messages?: { transaction_id?: string }[];
      message?: string;
      error?: string;
    };
    if (!res.ok) return {
      ok: false,
      error: json.message || json.error || `WebEx error ${res.status}`,
      outcomeUnknown: res.status === 408 || res.status === 409 || res.status >= 500,
    };
    return { ok: true, providerId: json.messages?.[0]?.transaction_id };
  } catch (err) {
    // Webex has no logical-send idempotency key in this integration. Never
    // automatically retry a request whose response may have been lost.
    return { ok: false, error: err instanceof Error ? err.message : "SMS send failed", outcomeUnknown: true };
  }
}
