/**
 * Session-free communication dispatcher. Every customer send is durably
 * claimed before a provider request; retries reuse the same logical row.
 */

import { createHash, randomUUID } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";
import { contentHash, normRecipient } from "@/lib/comms/hash";
import {
  emailPayloadHash,
  oversizedTemplateVars,
  sendEmail,
  sendEmailViaSmtpFallback,
  sendSms,
  shouldSmtpFallback,
  smtpFallbackConfigured,
  type SendEmailInput,
} from "@/lib/comms/send";
import { brandedEmailHtml } from "@/lib/comms/branded-shell";
import { DEFAULT_BRAND, type Brand } from "@/lib/brand";
import { log } from "@/lib/log";
import { opsAlertRecipient, type OpsAlertCategory } from "@/lib/comms/sender";
import { createAdminClient } from "@/lib/supabase/admin";
import { reportOperationalIssue, resolveOperationalIssue } from "@/lib/ops/issues";

type Sb = SupabaseClient<Database>;
type CommunicationRow = Database["public"]["Tables"]["communications"]["Row"];

/**
 * The exact provider request, stored on the communication row so a failed send
 * can be re-driven later (by the comms-retry worker) with the SAME idempotency
 * key and the SAME payload — no lossy reconstruction from the display columns.
 * The idempotency key is NOT stored here; it is always `marley-comm/<id>`.
 */
export interface ProviderRequest {
  channel: "email" | "sms";
  email?: SendEmailInput;
  /** The brand snapshot rides INSIDE the stored request so a comms-retry
   *  re-drive fronts the SAME sender id as the original send (trap 7); it is
   *  the shape sendSms takes. Absent = today's Marley env chain. */
  sms?: { to: string; body: string; brand?: Pick<Brand, "slug" | "smsSender"> | null };
}

export interface DispatchCommInput {
  channel: "email" | "sms";
  to: string;
  bodyText: string;
  subject?: string;
  bodyHtml?: string;
  template?: { id: string; variables?: Record<string, string | number> };
  attachmentBase64?: string;
  attachmentName?: string;
  replyTo?: string;
  from?: string;
  leadId?: string;
  quoteId?: string;
  clientId?: string;
  override?: boolean;
  overrideReason?: string;
  /** Sending brand (multi-brand PRD §3.5) — drives the SMS sender id, the
   *  default email subject, and the branded-shell chrome of the fallback
   *  render. Absent/marley behaves byte-identically to today. */
  brand?: Brand | null;
}

export type DispatchCommResult =
  | { ok: true }
  | { ok: false; error: string }
  | { duplicate: true; lastSentAt: string | null; sendCount: number };

type ClaimResult =
  | { claimed: true; row: Pick<CommunicationRow, "id" | "claim_token"> }
  | { duplicate: true; lastSentAt: string | null; sendCount: number }
  | { claimed: false; error: string };

const CLAIM_LEASE_MS = 5 * 60 * 1000;

async function claimCommunication(
  sb: Sb,
  baseRow: Database["public"]["Tables"]["communications"]["Insert"],
  dispatchKey: string | null,
  providerPayloadHash: string,
): Promise<ClaimResult> {
  const claimToken = randomUUID();
  const claimExpiresAt = new Date(Date.now() + CLAIM_LEASE_MS).toISOString();
  const { data: inserted, error: insertError } = await sb
    .from("communications")
    .insert({
      ...baseRow,
      status: "queued",
      dispatch_key: dispatchKey,
      claim_token: claimToken,
      claim_expires_at: claimExpiresAt,
      attempt_count: 1,
    })
    .select("id,claim_token")
    .single();

  if (!insertError && inserted) return { claimed: true, row: inserted };
  if (insertError?.code !== "23505" || !dispatchKey) {
    return { claimed: false, error: insertError?.message ?? "Could not claim communication" };
  }

  const { data: existing, error: existingError } = await sb
    .from("communications")
    .select("id,status,last_sent_at,send_count,claim_token,claim_expires_at,attempt_count,provider_outcome_unknown,provider_started_at,provider_payload_hash,channel")
    .eq("dispatch_key", dispatchKey)
    .maybeSingle();
  if (existingError || !existing) {
    return { claimed: false, error: existingError?.message ?? "Communication claim disappeared" };
  }
  // Order matters: a SENT row answers "duplicate" FIRST, payload hash or not.
  // The dedupe key (contentHash) deliberately ignores attachment BYTES, and a
  // regenerated quote PDF is never byte-identical (embedded timestamps), so a
  // re-send's payload hash always differs from the original — comparing it here
  // made every quote re-send hard-fail (2026-08-07, MMR042) instead of routing
  // to the dialog's confirm-and-override flow. The payload-hash refuse below
  // exists to protect RECLAIMS of unsent (queued/failed) rows from silently
  // swapping the payload under the same claim — sent rows are not reclaimed.
  if (existing.status === "sent") {
    return { duplicate: true, lastSentAt: existing.last_sent_at, sendCount: existing.send_count };
  }
  if (existing.provider_payload_hash && existing.provider_payload_hash !== providerPayloadHash) {
    return {
      claimed: false,
      error: "A previous send used this duplicate key with a different provider payload. Review it before overriding.",
    };
  }
  if (existing.provider_started_at && existing.channel === "sms") {
    return { claimed: false, error: "The previous SMS outcome is unknown. Check Webex before sending an override." };
  }
  if (
    existing.channel === "email" &&
    existing.provider_started_at &&
    Date.now() - new Date(existing.provider_started_at).getTime() >= 23 * 60 * 60 * 1000
  ) {
    return { claimed: false, error: "The previous email outcome is too old to retry safely. Check Resend before sending an override." };
  }
  if (
    existing.status === "queued" &&
    existing.claim_expires_at &&
    new Date(existing.claim_expires_at).getTime() > Date.now()
  ) {
    return { claimed: false, error: "An identical message is already being sent. Try again shortly." };
  }
  if (!existing.claim_token) {
    return { claimed: false, error: "The existing communication claim cannot be safely reclaimed." };
  }

  // Atomic database-time predicate prevents reclaim from racing finalisation.
  const { data: reclaimed, error: reclaimError } = await sb.rpc("reclaim_communication_send", {
    p_id: existing.id,
    p_old_claim_token: existing.claim_token,
    p_new_claim_token: claimToken,
    p_provider_payload_hash: providerPayloadHash,
    p_lease_seconds: Math.floor(CLAIM_LEASE_MS / 1000),
  });
  if (reclaimError) return { claimed: false, error: reclaimError.message };
  if (!reclaimed) return { claimed: false, error: "Another request reclaimed this communication first." };
  return { claimed: true, row: { id: existing.id, claim_token: claimToken } };
}

export async function dispatchComm(
  sb: Sb,
  actorId: string | null,
  input: DispatchCommInput,
): Promise<DispatchCommResult> {
  const toNorm = normRecipient(input.channel, input.to);
  const attachmentRef = input.attachmentName ?? null;
  const hash = contentHash({
    channel: input.channel,
    toNorm,
    subject: input.subject,
    body: input.bodyText,
    attachmentRef,
  });
  // A managed template is only usable when every variable fits Resend's
  // 2,000-char-per-value limit — an oversized one (a rich HTML block like
  // COMMITMENT_BLOCK, 2026-08-05 Brydee MMR034) fails the WHOLE send, and the
  // retry worker re-drives the same stored payload so it can never recover.
  // Every template sender also passes the in-repo bodyHtml, so fall back to
  // that; only when there is no fallback do we let the template try its luck.
  const overLimit = input.template ? oversizedTemplateVars(input.template.variables) : [];
  // On oversize, ALWAYS drop the template — even to the plain bodyText render:
  // a degraded body beats Resend's guaranteed 400 (the Brydee MMR034 failure).
  const useTemplate = !!input.template && overLimit.length === 0;
  if (input.template && overLimit.length > 0) {
    log.warn("comm.template.var_over_limit", {
      templateId: input.template.id,
      vars: overLimit,
      fellBack: !useTemplate,
    });
  }
  // Brand-resolved defaults (multi-brand PRD §3.5): absent/marley yields
  // exactly today's literals, so every existing caller is byte-unchanged.
  const brandDefaultSubject =
    input.brand && input.brand.slug !== DEFAULT_BRAND
      ? `Message from ${input.brand.name}`
      : "Message from Marley Moves";
  const emailInput: SendEmailInput | null = input.channel === "email"
    ? {
        to: input.to,
        subject: input.subject ?? brandDefaultSubject,
        ...(useTemplate
          ? {
              template: input.template!,
              // The SMTP fallback can't render Resend templates — carry the
              // in-repo body so an outage send still has content. Excluded
              // from the provider payload and its hash (see emailRequestPayload).
              fallbackHtml:
                input.bodyHtml ??
                brandedEmailHtml({
                  preheader: input.subject ?? input.bodyText.slice(0, 120),
                  paragraphs: input.bodyText.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean),
                  brand: input.brand,
                }),
            }
          : {
              html:
                input.bodyHtml ??
                brandedEmailHtml({
                  preheader: input.subject ?? input.bodyText.slice(0, 120),
                  paragraphs: input.bodyText.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean),
                  brand: input.brand,
                }),
            }),
        attachments: input.attachmentBase64
          ? [{ filename: input.attachmentName ?? "attachment.pdf", content: input.attachmentBase64 }]
          : undefined,
        replyTo: input.replyTo,
        from: input.from,
        // Snapshot the reply-identity fields for a non-default brand so the
        // FALLBACK Reply-To (emailReplyToFor — a tokenless send) fronts the
        // brand's own door, and a comms-retry re-drive of the stored request
        // fronts the SAME one (trap 7's email sibling). Marley rows carry no
        // snapshot and stay byte-identical to today.
        ...(input.brand && input.brand.slug !== DEFAULT_BRAND
          ? { brand: { slug: input.brand.slug, helloFrom: input.brand.helloFrom } }
          : {}),
      }
    : null;
  const providerPayloadHash = emailInput
    ? emailPayloadHash(emailInput)
    : createHash("sha256").update(JSON.stringify({ to: toNorm, body: input.bodyText })).digest("hex");
  const providerRequest: ProviderRequest = emailInput
    ? { channel: "email", email: emailInput }
    : {
        channel: "sms",
        sms: {
          to: input.to,
          body: input.bodyText,
          // Snapshot only the two fields sendSms reads, and only for a
          // non-default brand — Marley rows stay byte-identical to today.
          ...(input.brand && input.brand.slug !== DEFAULT_BRAND
            ? { brand: { slug: input.brand.slug, smsSender: input.brand.smsSender } }
            : {}),
        },
      };
  const opsSb = createAdminClient();
  const baseRow = {
    client_id: input.clientId ?? null,
    lead_id: input.leadId ?? null,
    quote_id: input.quoteId ?? null,
    channel: input.channel,
    to_address: input.to,
    to_norm: toNorm,
    subject: input.subject ?? null,
    body: input.bodyText,
    attachment_ref: attachmentRef,
    content_hash: hash,
    sent_by: actorId,
    is_override: !!input.override,
    override_reason: input.overrideReason ?? null,
    provider: input.channel === "email" ? "resend" : "webex",
    provider_payload_hash: providerPayloadHash,
  } satisfies Database["public"]["Tables"]["communications"]["Insert"];

  const claim = await claimCommunication(sb, baseRow, input.override ? null : hash, providerPayloadHash);
  if ("duplicate" in claim) return claim;
  if (!claim.claimed) {
    await reportOperationalIssue(opsSb, {
      key: `communication-claim:${hash}`,
      severity: "error",
      source: "communications",
      event: "comm.claim.failed",
      message: "An outbound communication could not be durably claimed.",
      context: { channel: input.channel, quoteId: input.quoteId ?? null, error: claim.error },
    });
    return { ok: false, error: claim.error };
  }

  const communicationId = claim.row.id;
  const claimToken = claim.row.claim_token;
  if (!claimToken) return { ok: false, error: "Communication claim token was not returned." };

  // Persist the exact provider request so the comms-retry worker can re-drive a
  // failed send with the SAME idempotency key (marley-comm/<id>) and payload —
  // no lossy reconstruction, no drift. A no-op re-write on the reclaim path.
  await sb
    .from("communications")
    .update({ provider_request: providerRequest as unknown as Json } as never)
    .eq("id", communicationId)
    .eq("claim_token", claimToken);

  return runProviderSend(sb, opsSb, {
    communicationId,
    claimToken,
    channel: input.channel,
    providerRequest,
    leadId: input.leadId ?? null,
    clientId: input.clientId ?? null,
    actorId,
    to: input.to,
    subject: input.subject ?? null,
    claimIssueKey: `communication-claim:${hash}`,
    override: !!input.override,
  });
}

/**
 * Drive a CLAIMED communication row to the provider and finalise it. Shared by
 * dispatchComm (first send) and the comms-retry worker (re-drive) so there is
 * ONE implementation of start → send → finalise/fail → resolve/report. The
 * caller must already hold the claim (`claimToken`); this reads the payload from
 * `providerRequest` and always sends email under the stable `marley-comm/<id>`
 * idempotency key, so a re-drive cannot double-send.
 */
export async function runProviderSend(
  sb: Sb,
  opsSb: Sb,
  a: {
    communicationId: string;
    claimToken: string;
    channel: "email" | "sms";
    providerRequest: ProviderRequest;
    leadId: string | null;
    clientId: string | null;
    actorId: string | null;
    to: string;
    subject: string | null;
    claimIssueKey?: string | null;
    override?: boolean;
    retried?: boolean;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { communicationId, claimToken, channel } = a;

  const { data: providerStarted, error: providerStartError } = await sb.rpc("start_communication_provider", {
    p_id: communicationId,
    p_claim_token: claimToken,
  });
  if (providerStartError || !providerStarted) {
    await reportOperationalIssue(opsSb, {
      key: `communication:${communicationId}`,
      severity: "error",
      source: "communications",
      event: "comm.provider_start.failed",
      message: "A claimed communication could not be marked before provider dispatch.",
      context: { communicationId, channel, error: providerStartError?.message },
    });
    return { ok: false, error: "Message was not sent because its durable claim could not be confirmed." };
  }

  let result = channel === "email"
    ? await sendEmail({ ...(a.providerRequest.email as SendEmailInput), idempotencyKey: `marley-comm/${communicationId}` })
    : await sendSms(a.providerRequest.sms ?? { to: a.to, body: "" });

  // IONOS SMTP fallback — outage classes only (shouldSmtpFallback), and at
  // most ONE SMTP transmission per row EVER: SMTP has no idempotency key, so
  // a re-driven row that dialled once must never dial again (an ambiguous
  // SMTP failure may in fact have delivered). The CAS on
  // smtp_fallback_attempted_at is that guarantee — claim-first, then dial.
  if (
    channel === "email" &&
    !result.ok &&
    !result.simulated &&
    smtpFallbackConfigured() &&
    shouldSmtpFallback(result, true)
  ) {
    const { data: fbClaim } = await sb
      .from("communications")
      .update({ smtp_fallback_attempted_at: new Date().toISOString() } as never)
      .eq("id", communicationId)
      .eq("claim_token", claimToken)
      .is("smtp_fallback_attempted_at", null)
      .select("id");
    if (fbClaim?.length) {
      const resendFailure = { error: result.error ?? null, status: result.status ?? null };
      const fallback = await sendEmailViaSmtpFallback(a.providerRequest.email as SendEmailInput);
      if (fallback.ok) {
        result = fallback;
        // Stamp the audit row FIRST (a later finalize failure must not lose
        // which transport accepted the send — "check Resend" would find
        // nothing and invite a duplicate hand-resend), and raise a PERSISTENT
        // visible issue: a green board during a silent Resend outage is how a
        // degraded transport becomes permanent.
        log.warn("comm.sent_via_smtp_fallback", { communicationId, channel, resendFailure });
        const { error: stampError } = await sb
          .from("communications")
          .update({ provider: "smtp-fallback" } as never)
          .eq("id", communicationId)
          .eq("claim_token", claimToken);
        if (stampError) log.error("comm.smtp_fallback.stamp_failed", { communicationId, error: stampError.message });
        await reportOperationalIssue(opsSb, {
          key: "resend-fallback-active",
          severity: "error",
          source: "communications",
          event: "comm.smtp_fallback.used",
          message:
            "Email is being delivered via the IONOS SMTP fallback (from the accounts desk, plain body) — Resend is failing. Check the Resend key/account.",
          context: { communicationId, resendFailure },
        });
      } else {
        // The SMTP attempt left the process and failed AMBIGUOUSLY (it may
        // have delivered). Mark the outcome unknown so the row keeps
        // provider_started_at (23h re-drive window) and every human-facing
        // escalation says "outcome unknown", never "provably not delivered".
        result = { ...result, outcomeUnknown: true, error: `${result.error} (and ${fallback.error})` };
      }
    }
  }

  if (!result.ok) {
    const errMsg = result.error ?? "Send failed";
    const { error: failureLogError } = await sb
      .from("communications")
      .update({
        status: "failed",
        provider_error: errMsg,
        provider_outcome_unknown: !!result.outcomeUnknown,
        claim_expires_at: null,
        ...(!result.outcomeUnknown ? { provider_started_at: null } : {}),
      })
      .eq("id", communicationId)
      .eq("claim_token", claimToken);
    await reportOperationalIssue(opsSb, {
      key: `communication:${communicationId}`,
      severity: result.outcomeUnknown && channel === "sms" ? "critical" : "error",
      source: "communications",
      event: "comm.provider.failed",
      message: result.outcomeUnknown
        ? "The communication provider outcome is unknown."
        : "The communication provider rejected the send.",
      context: {
        communicationId,
        channel,
        outcomeUnknown: !!result.outcomeUnknown,
        error: errMsg,
        failureLogError: failureLogError?.message,
      },
    });
    return { ok: false, error: errMsg };
  }

  // Resend delivered a real email — if the fallback issue is open, the outage
  // is over and the board should say so (no-op when it was never open).
  if (channel === "email" && !result.simulated && result.provider !== "smtp-fallback") {
    await resolveOperationalIssue(opsSb, "resend-fallback-active");
  }

  const { data: finalised, error: finaliseError } = await sb.rpc("finalize_communication_send", {
    p_id: communicationId,
    p_claim_token: claimToken,
    p_provider_id: result.providerId ?? "",
    p_sent_at: new Date().toISOString(),
  });
  if (finaliseError || !finalised) {
    // Provider accepted the send. Do not invite a retry; surface the missing
    // audit/counter finalisation as a critical operational issue instead —
    // naming WHICH transport accepted it, so the human checks the right one.
    await reportOperationalIssue(opsSb, {
      key: `communication:${communicationId}`,
      severity: "critical",
      source: "communications",
      event: "comm.finalize.failed",
      message: "Provider accepted a communication but database finalisation failed.",
      context: { communicationId, channel, provider: result.provider ?? "resend", error: finaliseError?.message },
    });
    return { ok: true };
  }
  await resolveOperationalIssue(opsSb, `communication:${communicationId}`);
  if (a.claimIssueKey) await resolveOperationalIssue(opsSb, a.claimIssueKey);

  if (a.leadId || a.clientId) {
    const { error: activityError } = await sb.from("activities").insert({
      lead_id: a.leadId ?? null,
      client_id: a.clientId ?? null,
      actor_id: a.actorId,
      type: channel === "email" ? "email_sent" : "sms_sent",
      summary: `${channel === "email" ? "Email" : "SMS"} sent to ${a.to}${a.subject ? ` — ${a.subject}` : ""}`,
      meta: {
        provider_id: result.providerId ?? null,
        override: a.override ?? false,
        ...(a.retried ? { retried: true } : {}),
      },
    });
    if (activityError) {
      await reportOperationalIssue(opsSb, {
        key: `communication-activity:${communicationId}`,
        severity: "warning",
        source: "communications",
        event: "comm.activity.failed",
        message: "A sent communication is missing its timeline activity.",
        context: { communicationId, error: activityError.message },
      });
    } else {
      await resolveOperationalIssue(opsSb, `communication-activity:${communicationId}`);
    }
  }

  return { ok: true };
}

/** Best-effort internal alert with provider idempotency and durable failure state. */
export async function sendOpsAlert(
  subject: string,
  lines: string[],
  category: OpsAlertCategory = "business",
  idempotencyKey?: string,
): Promise<boolean> {
  const to = opsAlertRecipient(category);
  const alertHash = createHash("sha256")
    .update(JSON.stringify({ category, to, subject, lines }))
    .digest("hex")
    .slice(0, 32);
  const issueKey = `ops-alert:${alertHash}`;
  try {
    const payload = {
      to,
      subject: `[Marley Ops] ${subject}`,
      html: `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;color:#1a1a1a;line-height:1.7;">${lines
        .map((line) => `<p style="margin:0 0 6px;">${line}</p>`)
        .join("")}</div>`,
      idempotencyKey: idempotencyKey ?? `marley-ops/${alertHash}`,
    };
    let result = await sendEmail(payload);
    // Alerts must survive the outage class they exist to report. The SMTP
    // fallback was wired into runProviderSend only, so during a Resend outage
    // customer mail degraded gracefully to IONOS while EVERY internal alert —
    // "Date at risk", "Balance OVERDUE after move day", "a customer message may
    // be undelivered", and the "Resend is failing" notice itself — failed
    // silently. Same safety reasoning as the customer path: only fall back when
    // Resend definitively did not send (401/403/429) or the outcome is unknown
    // under an idempotency key, so this can never double-send.
    if (!result.ok && smtpFallbackConfigured() && shouldSmtpFallback(result, true)) {
      const viaSmtp = await sendEmailViaSmtpFallback(payload);
      log.warn("ops.alert.smtp_fallback", { category, ok: viaSmtp.ok, resendError: result.error });
      if (viaSmtp.ok) result = viaSmtp;
    }
    const sb = createAdminClient();
    if (!result.ok) {
      await reportOperationalIssue(sb, {
        key: issueKey,
        severity: "error",
        source: "ops-alert",
        event: "ops.alert.failed",
        message: "An internal operations alert could not be delivered.",
        context: { category, error: result.error, outcomeUnknown: !!result.outcomeUnknown },
      });
      return false;
    }
    await resolveOperationalIssue(sb, issueKey);
    return true;
  } catch (error) {
    log.error("ops.alert.threw", { category, error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}
