/**
 * Session-free communication dispatcher. Every customer send is durably
 * claimed before a provider request; retries reuse the same logical row.
 */

import { createHash, randomUUID } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { contentHash, normRecipient } from "@/lib/comms/hash";
import { emailPayloadHash, sendEmail, sendSms, type SendEmailInput } from "@/lib/comms/send";
import { brandedEmailHtml } from "@/lib/comms/branded-shell";
import { log } from "@/lib/log";
import { opsAlertRecipient, type OpsAlertCategory } from "@/lib/comms/sender";
import { createAdminClient } from "@/lib/supabase/admin";
import { reportOperationalIssue, resolveOperationalIssue } from "@/lib/ops/issues";

type Sb = SupabaseClient<Database>;
type CommunicationRow = Database["public"]["Tables"]["communications"]["Row"];

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
  if (existing.provider_payload_hash && existing.provider_payload_hash !== providerPayloadHash) {
    return {
      claimed: false,
      error: "A previous send used this duplicate key with a different provider payload. Review it before overriding.",
    };
  }
  if (existing.status === "sent") {
    return { duplicate: true, lastSentAt: existing.last_sent_at, sendCount: existing.send_count };
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
  const emailInput: SendEmailInput | null = input.channel === "email"
    ? {
        to: input.to,
        subject: input.subject ?? "Message from Marley Moves",
        ...(input.template
          ? { template: input.template }
          : {
              html:
                input.bodyHtml ??
                brandedEmailHtml({
                  preheader: input.subject ?? input.bodyText.slice(0, 120),
                  paragraphs: input.bodyText.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean),
                }),
            }),
        attachments: input.attachmentBase64
          ? [{ filename: input.attachmentName ?? "attachment.pdf", content: input.attachmentBase64 }]
          : undefined,
        replyTo: input.replyTo,
        from: input.from,
      }
    : null;
  const providerPayloadHash = emailInput
    ? emailPayloadHash(emailInput)
    : createHash("sha256").update(JSON.stringify({ to: toNorm, body: input.bodyText })).digest("hex");
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
      context: { communicationId, channel: input.channel, error: providerStartError?.message },
    });
    return { ok: false, error: "Message was not sent because its durable claim could not be confirmed." };
  }

  const result = input.channel === "email"
    ? await sendEmail({
        ...emailInput!,
        idempotencyKey: `marley-comm/${communicationId}`,
      })
    : await sendSms({ to: input.to, body: input.bodyText });

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
      severity: result.outcomeUnknown && input.channel === "sms" ? "critical" : "error",
      source: "communications",
      event: "comm.provider.failed",
      message: result.outcomeUnknown
        ? "The communication provider outcome is unknown."
        : "The communication provider rejected the send.",
      context: {
        communicationId,
        channel: input.channel,
        outcomeUnknown: !!result.outcomeUnknown,
        error: errMsg,
        failureLogError: failureLogError?.message,
      },
    });
    return { ok: false, error: errMsg };
  }

  const { data: finalised, error: finaliseError } = await sb.rpc("finalize_communication_send", {
    p_id: communicationId,
    p_claim_token: claimToken,
    p_provider_id: result.providerId ?? "",
    p_sent_at: new Date().toISOString(),
  });
  if (finaliseError || !finalised) {
    // Provider accepted the send. Do not invite a retry; surface the missing
    // audit/counter finalisation as a critical operational issue instead.
    await reportOperationalIssue(opsSb, {
      key: `communication:${communicationId}`,
      severity: "critical",
      source: "communications",
      event: "comm.finalize.failed",
      message: "Provider accepted a communication but database finalisation failed.",
      context: { communicationId, channel: input.channel, error: finaliseError?.message },
    });
    return { ok: true };
  }
  await resolveOperationalIssue(opsSb, `communication:${communicationId}`);
  await resolveOperationalIssue(opsSb, `communication-claim:${hash}`);

  if (input.leadId || input.clientId) {
    const { error: activityError } = await sb.from("activities").insert({
      lead_id: input.leadId ?? null,
      client_id: input.clientId ?? null,
      actor_id: actorId,
      type: input.channel === "email" ? "email_sent" : "sms_sent",
      summary: `${input.channel === "email" ? "Email" : "SMS"} sent to ${input.to}${
        input.subject ? ` — ${input.subject}` : ""
      }`,
      meta: { provider_id: result.providerId ?? null, override: !!input.override },
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
    const result = await sendEmail({
      to,
      subject: `[Marley Ops] ${subject}`,
      html: `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;color:#1a1a1a;line-height:1.7;">${lines
        .map((line) => `<p style="margin:0 0 6px;">${line}</p>`)
        .join("")}</div>`,
      idempotencyKey: idempotencyKey ?? `marley-ops/${alertHash}`,
    });
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
