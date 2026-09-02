/** Low-level senders. SERVER ONLY. A COMMS_DRYRUN=true env short-circuits to a simulated
 *  success so the panel's send + duplicate-guard flow is testable locally without real sends. */

import { createHash } from "node:crypto";
import { DEFAULT_BRAND, GROUP_BRAND, type Brand } from "@/lib/brand";

export interface SendResult {
  ok: boolean;
  providerId?: string;
  error?: string;
  /** True when COMMS_DRYRUN short-circuited without contacting a provider. */
  simulated?: boolean;
  /** The request left this process but the transport outcome is unknowable. */
  outcomeUnknown?: boolean;
  /** HTTP status from the provider on a definite reject (fallback classifier). */
  status?: number;
  /** Which transport actually delivered — absent means the primary (Resend). */
  provider?: "smtp-fallback";
}

const DRYRUN = process.env.COMMS_DRYRUN === "true";

/**
 * Backoff between in-process email retries (3 attempts total). Kept short so a
 * user-facing send path isn't held up for long; the comms-retry worker is the
 * durable backstop for anything a quick retry can't rescue. Skipped under the
 * test runner so the suite stays fast while still exercising the retry loop.
 */
const EMAIL_RETRY_DELAYS_MS = [400, 1200];
const retryDelay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, process.env.VITEST ? 0 : ms));

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
  /** Rendered in-repo HTML carried alongside a `template` send so the SMTP
   *  fallback (which cannot render Resend templates) still has a body.
   *  NEVER part of the provider payload or its hash. */
  fallbackHtml?: string;
  /** Sending brand — resolves the FALLBACK Reply-To when `replyTo` is absent
   *  (emailReplyToFor below): a tokenless non-default-brand email must not
   *  invite replies to Marley's front door. Only the two fields the resolver
   *  reads, mirroring sendSms's snapshot shape. Never part of the provider
   *  payload; absent = today's Marley fallback, byte-identical. */
  brand?: Pick<Brand, "slug" | "helloFrom"> | null;
}

/**
 * The fallback Reply-To fronting an email that has NO tokenized reply address
 * (multi-brand PRD §3.5) — the email sibling of smsSenderFor below. A brand
 * that is not the default answers for ITSELF: its hello_from front door,
 * provided the value is a plain local@domain token (the same hardening
 * sender.ts's plainAddress applies before an address becomes a live header —
 * a Settings-editable value must never smuggle header syntax). The default
 * brand, the group pseudo-brand (group comms keep the operating company's
 * identity, §11.10) and a stub row without a usable address all resolve to
 * today's literal hello@marleymoves.co.uk — a monitored Marley mailbox beats
 * a dead header, and every pre-brand-layer send stays byte-identical.
 */
export function emailReplyToFor(brand?: Pick<Brand, "slug" | "helloFrom"> | null): string {
  if (brand && brand.slug !== DEFAULT_BRAND && brand.slug !== GROUP_BRAND) {
    const addr = (brand.helloFrom ?? "").trim().toLowerCase();
    if (/^[a-z0-9._+-]+@[a-z0-9.-]+$/.test(addr)) return addr;
  }
  return "hello@marleymoves.co.uk";
}

/** Resend hard-rejects any template variable value over 2,000 characters
 *  ("The `template, variables, value` field has a 2,000 character limit per
 *  value") — and it kills the WHOLE send, not just the variable. */
export const RESEND_TEMPLATE_VAR_LIMIT = 2000;

/** Names of template variables whose value exceeds the provider limit. */
export function oversizedTemplateVars(vars?: Record<string, string | number>): string[] {
  return Object.entries(vars ?? {})
    .filter(([, v]) => String(v).length > RESEND_TEMPLATE_VAR_LIMIT)
    .map(([k]) => k);
}

function emailRequestPayload(input: SendEmailInput) {
  return {
    from: input.from || process.env.RESEND_FROM_EMAIL || "Marley Moves <hello@marleymoves.co.uk>",
    to: [input.to],
    reply_to: input.replyTo || emailReplyToFor(input.brand),
    subject: input.subject,
    ...(input.template ? { template: input.template } : { html: input.html }),
    attachments: input.attachments,
  };
}

/** Hash of the exact JSON payload sent to Resend (excluding the retry key). */
export function emailPayloadHash(input: SendEmailInput): string {
  return createHash("sha256").update(JSON.stringify(emailRequestPayload(input))).digest("hex");
}

async function sendEmailOnce(input: SendEmailInput, key: string): Promise<SendResult> {
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
      status: res.status,
    };
    return { ok: true, providerId: json.id };
  } catch (err) {
    // A retry with the same Idempotency-Key is safe even if the response was lost.
    return { ok: false, error: err instanceof Error ? err.message : "Email send failed", outcomeUnknown: true };
  }
}

/* ------------------------------------------------- SMTP fallback (IONOS) */

export const smtpFallbackConfigured = (): boolean =>
  Boolean(process.env.SMTP_FALLBACK_HOST && process.env.SMTP_FALLBACK_USER && process.env.SMTP_FALLBACK_PASS);

/**
 * Whether a TERMINAL Resend failure (the in-process retries already ran) may
 * be retried over the SMTP fallback. Pure so the double-send reasoning is
 * unit-locked:
 *  - 401/403 — Resend account-level trouble (revoked key, suspension).
 *    Resend definitively did NOT send; SMTP is safe and is exactly the outage
 *    class a backup transport exists for.
 *  - 429 — only reachable here after the in-process retries ALSO 429'd
 *    (sendEmail retries 429s: it's normally the per-second rate limit and the
 *    backoff clears it without degrading the send). A sustained 429 is quota
 *    exhaustion — outage class, and Resend did not send.
 *  - outcomeUnknown after the idempotency-keyed retries — Resend down or
 *    unreachable. The keyed retries make "it actually sent but every response
 *    was lost" vanishingly unlikely (a reused key returns the ORIGINAL result),
 *    so we accept the residual double-send risk over stranding the customer.
 *    WITHOUT a key that mitigation doesn't exist, so never fall back there.
 *  - Payload rejects (400/422 — bad address, malformed content) never fall
 *    back: the same payload fails on any transport, twice as embarrassingly.
 *
 * The CALLER (runProviderSend) additionally enforces the one-shot rule: a
 * communication row gets at most ONE SMTP transmission ever, CAS-claimed on
 * smtp_fallback_attempted_at — SMTP has no idempotency key, so re-dialling on
 * a re-drive could double-send.
 */
export function shouldSmtpFallback(result: SendResult, hadIdempotencyKey: boolean): boolean {
  if (result.ok) return false;
  if (result.status === 401 || result.status === 403 || result.status === 429) return true;
  return !!result.outcomeUnknown && hadIdempotencyKey;
}

/** Whether a failed Resend ATTEMPT is safe + worth retrying in-process:
 *  outcome-unknown blips only under an idempotency key (a reused key returns
 *  the original result, so it cannot double-send), and 429 always (Resend's
 *  per-second rate limit — it definitively did not send, and the 400/1200ms
 *  backoff outlasts the ~1s Retry-After). */
export function shouldRetryResendAttempt(result: SendResult, hadIdempotencyKey: boolean): boolean {
  if (result.ok) return false;
  if (result.status === 429) return true;
  return !!result.outcomeUnknown && hadIdempotencyKey;
}

export async function sendEmailViaSmtpFallback(input: SendEmailInput): Promise<SendResult> {
  const html = input.html ?? input.fallbackHtml;
  if (!html) return { ok: false, error: "SMTP fallback has no HTML body for this send." };
  try {
    const nodemailer = await import("nodemailer");
    const port = Number(process.env.SMTP_FALLBACK_PORT || 465);
    const user = process.env.SMTP_FALLBACK_USER!;
    const transport = nodemailer.createTransport({
      host: process.env.SMTP_FALLBACK_HOST!,
      port,
      secure: port === 465,
      auth: { user, pass: process.env.SMTP_FALLBACK_PASS! },
      connectionTimeout: 15_000,
      socketTimeout: 20_000,
    });
    const info = await transport.sendMail({
      // IONOS only relays mail From its authenticated mailbox, so the fallback
      // sends as the accounts desk regardless of the original identity — an
      // outage email from accounts@ beats no email. Reply-To is preserved, so
      // the q-<token> reply relay (chase pausing, logging) keeps working.
      from: process.env.SMTP_FALLBACK_FROM || `Marley Moves <${user}>`,
      to: input.to,
      replyTo: input.replyTo || emailReplyToFor(input.brand),
      subject: input.subject,
      html,
      attachments: (input.attachments ?? []).map((a) => ({
        filename: a.filename,
        content: a.content,
        encoding: "base64" as const,
      })),
    });
    return { ok: true, providerId: info.messageId, provider: "smtp-fallback" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? `SMTP fallback: ${err.message}` : "SMTP fallback failed" };
  }
}

export async function sendEmail(input: SendEmailInput): Promise<SendResult> {
  if (DRYRUN) return { ok: true, providerId: `dryrun-email-${Date.now()}`, simulated: true };
  const key = process.env.MARLEY_RESEND_API_KEY || process.env.RESEND_API_KEY;
  if (!key) return { ok: false, error: "Resend API key not configured" };
  if (!input.template && !input.html) return { ok: false, error: "No email body (html or template) given" };

  // In-process retry for two safe classes (shouldRetryResendAttempt): keyed
  // outcome-unknown blips — Resend retains a key for 24h and returns the
  // original result on reuse, so re-sending after a timeout / 5xx cannot
  // double-send (exactly the "operation aborted due to timeout" that stranded
  // a real deposit chase, 2026-08-03) — and 429s, which are normally the
  // per-second rate limit that a burst (chase cron, retry sweep) trips: the
  // backoff clears them without degrading the send. A definite reject (bad
  // address, 4xx) exits immediately — retrying it only wastes time. The
  // comms-retry worker is the durable backstop beyond these attempts, and
  // runProviderSend owns the one-shot SMTP fallback for outage classes.
  let result: SendResult = { ok: false, error: "Email send failed" };
  for (let i = 0; i < EMAIL_RETRY_DELAYS_MS.length + 1; i++) {
    if (i > 0) await retryDelay(EMAIL_RETRY_DELAYS_MS[i - 1]);
    result = await sendEmailOnce(input, key);
    if (result.ok) return result;
    if (!shouldRetryResendAttempt(result, !!input.idempotencyKey)) break;
  }
  return result;
}

/**
 * The SMS sender id fronting a message (PRD §11.7 trap 7). A brand that is not
 * the default answers for ITSELF: its brands.sms_sender, or nothing. The env
 * pair is the default brand's chain and stays the default brand's, exactly like
 * templateIdFor's env fallback (trap 4). The group pseudo-brand comes through
 * it too, because group comms deliberately keep the operating company's
 * identity (§11.10).
 *
 * Undefined means sendSms REFUSES, which is the point. Falling back put the
 * default brand's sender id on another brand's money chase: the body says one
 * brand, the handset says another, and the customer's reply routes to a rail
 * with no record of them (QA-20260826-08). A refusal is loud — a failed
 * communication row, a comm.provider.failed issue on the ops board, and an
 * error toast on the click — whereas a misattributed chase is visible only to
 * the customer. Pure and exported so the reasoning stays unit-locked, like
 * shouldSmtpFallback above.
 */
export function smsSenderFor(brand?: Pick<Brand, "slug" | "smsSender"> | null): string | undefined {
  if (brand && brand.slug !== DEFAULT_BRAND && brand.slug !== GROUP_BRAND) {
    // `||` not `??`: callers build this Pick by hand, so an empty string must
    // not become the sender id.
    return brand.smsSender || undefined;
  }
  return process.env.WEBEX_SMS_SENDER_MARLEY_MOVES || process.env.WEBEX_SMS_SENDER;
}

export async function sendSms(input: {
  to: string;
  body: string;
  /** Brand whose sender id fronts the SMS — absent defaults to Marley, so
   *  callers that don't thread a brand behave byte-identically to today. */
  brand?: Pick<Brand, "slug" | "smsSender"> | null;
}): Promise<SendResult> {
  if (DRYRUN) return { ok: true, providerId: `dryrun-sms-${Date.now()}`, simulated: true };
  const key = process.env.WEBEX_API_KEY;
  const sender = smsSenderFor(input.brand);
  if (!key) return { ok: false, error: "WebEx API key not configured" };
  if (!sender) {
    // Name the actual remedy: for a non-default brand the env vars are fine and
    // the missing value is a database column, so the generic message would send
    // whoever reads the ops board to the wrong place. The promised recovery is
    // real because the comms-retry worker re-reads brands.sms_sender before it
    // re-drives an SMS (liveSmsBrand) — the stored payload's brand snapshot is
    // frozen at send time, so without that re-read setting the column would fix
    // nothing for the row that prompted the message.
    const slug = input.brand?.slug;
    const brandScoped = !!slug && slug !== DEFAULT_BRAND && slug !== GROUP_BRAND;
    return {
      ok: false,
      error: brandScoped
        ? `No SMS sender id configured for brand ${slug}. Set brands.sms_sender for ${slug} — this message is held and goes out on the next retry once it is set.`
        : "WebEx sender ID not configured",
    };
  }
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
