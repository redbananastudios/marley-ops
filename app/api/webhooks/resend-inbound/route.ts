import { createHash, createHmac, timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { createAdminClient } from "@/lib/supabase/admin";
import { emailPayloadHash, sendEmail } from "@/lib/comms/send";
import { sendOpsAlert } from "@/lib/comms/dispatch";
import { classifyBounce, suppressesAddress } from "@/lib/comms/bounce";
import { htmlToText, splitReply } from "@/lib/comms/extract-reply";
import { leadOwnerIdentity, shouldForwardUnmatched } from "@/lib/comms/sender";
import { tokenFromReplyAddress } from "@/lib/quote/chase";
import { fetchQuoteByToken } from "@/lib/quote/accept-flow";
import { errorContext, log } from "@/lib/log";
import { reportOperationalIssue, resolveOperationalIssue } from "@/lib/ops/issues";

export const dynamic = "force-dynamic";

type Sb = SupabaseClient<Database>;
type InboundEvent = {
  type?: string;
  data?: {
    email_id?: string;
    id?: string;
    from?: string;
    to?: string[];
    subject?: string;
    /** Delivery-failure events carry the classification here. */
    bounce?: { type?: string; subType?: string; message?: string };
  };
};

/** Delivery-failure events we act on (everything else is still ignored). */
const BOUNCE_EVENTS = new Set(["email.bounced", "email.complained", "email.failed"]);

function verifySvix(payload: string, headers: Headers, secret: string): boolean {
  const id = headers.get("svix-id");
  const timestamp = headers.get("svix-timestamp");
  const signatures = headers.get("svix-signature");
  if (!id || !timestamp || !signatures) return false;
  const timestampNumber = Number(timestamp);
  if (!Number.isFinite(timestampNumber) || Math.abs(Date.now() / 1000 - timestampNumber) > 300) return false;
  try {
    const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
    const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${payload}`).digest("base64");
    return signatures.split(" ").some((part) => {
      const signature = part.split(",")[1] ?? "";
      const actual = Buffer.from(signature);
      const wanted = Buffer.from(expected);
      return actual.length === wanted.length && timingSafeEqual(actual, wanted);
    });
  } catch {
    return false;
  }
}

const esc = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The forwarded-reply body: the customer's NEW words in a prominent card, then —
 * when we could separate it — the quoted original they replied to in a muted,
 * clearly-labelled block underneath (Peter, 2026-08-04: "separating the original
 * that they are replying to and their response, so this will be easy to read").
 * The quoted half is context, not content, so it's capped rather than complete.
 */
function forwardBodyHtml(intro: string, replyText: string, quotedText: string, footer: string): string {
  const cappedQuote = quotedText.length > 1800 ? `${quotedText.slice(0, 1800).trimEnd()}…` : quotedText;
  const quotedBlock = cappedQuote
    ? `<p style="margin:18px 0 6px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:#a1a1aa;">They were replying to</p>
      <div style="color:#71717a;font-size:12.5px;line-height:1.6;border-left:2px solid #e4e4e7;padding:2px 0 2px 12px;white-space:pre-wrap;">${esc(cappedQuote)}</div>`
    : "";
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;color:#1a1a1a;line-height:1.7;max-width:640px;">
    <p style="margin:0 0 14px;">${intro}</p>
    <div style="background:#fafaf9;border:1px solid #e4e4e7;border-left:3px solid #c03838;border-radius:6px;padding:14px 18px;white-space:pre-wrap;">${esc(replyText)}</div>
    ${quotedBlock}
    <p style="margin:18px 0 0;font-size:12px;color:#71717a;">${footer}</p>
  </div>`;
}

/**
 * The customer's message source: the plain-text part, or the HTML flattened to
 * text when the reply is HTML-only (Gmail/iPhone Mail) with an empty text part.
 * Without the HTML fallback an HTML-only reply is lost entirely (Priscilla Kong,
 * MMR020, 2026-08-03). Feed the result through extractReplyText to strip quotes.
 */
function replyBodySource(content: { text?: string; html?: string } | null): string {
  const text = content?.text?.trim();
  return text ? content!.text! : htmlToText(content?.html);
}

async function fetchReceivedEmail(emailId: string): Promise<{ text?: string; html?: string } | null> {
  const key = process.env.MARLEY_RESEND_API_KEY || process.env.RESEND_API_KEY;
  if (!key) return null;
  for (const path of [`/emails/receiving/${emailId}`, `/emails/${emailId}`]) {
    try {
      const response = await fetch(`https://api.resend.com${path}`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(20_000),
      });
      if (response.ok) return (await response.json()) as { text?: string; html?: string };
    } catch {
      // The next compatible Resend endpoint is attempted.
    }
  }
  return null;
}

async function sendDurableWebhookEmail(
  sb: Sb,
  eventId: string,
  leaseToken: string,
  step: string,
  input: Parameters<typeof sendEmail>[0],
): Promise<void> {
  const { data: rows, error: claimError } = await sb.rpc("claim_webhook_delivery_step", {
    p_provider: "resend",
    p_event_id: eventId,
    p_lease_token: leaseToken,
    p_step: step,
    p_payload_hash: emailPayloadHash(input),
  });
  const claim = rows?.[0];
  if (claimError || !claim) throw new Error(`Claim ${step} delivery: ${claimError?.message ?? "no result"}`);
  if (claim.decision === "completed") return;
  if (claim.decision === "manual_review") {
    throw new Error(`${step} delivery is outside Resend's safe idempotency window; manual review required`);
  }
  if (claim.decision === "payload_mismatch") {
    throw new Error(`${step} delivery payload changed after its first attempt; manual review required`);
  }
  if (claim.decision !== "send" && claim.decision !== "retry_safe") {
    throw new Error(`${step} delivery lease is no longer valid`);
  }

  const result = await sendEmail(input);
  if (!result.ok) {
    await sb.rpc("fail_webhook_delivery_step", {
      p_provider: "resend",
      p_event_id: eventId,
      p_lease_token: leaseToken,
      p_step: step,
      p_outcome_unknown: !!result.outcomeUnknown,
    });
    throw new Error(`${step} delivery failed: ${result.error ?? "unknown provider error"}`);
  }
  const { data: completed, error: completeError } = await sb.rpc("complete_webhook_delivery_step", {
    p_provider: "resend",
    p_event_id: eventId,
    p_step: step,
    p_provider_id: result.providerId ?? "",
  });
  if (completeError || !completed) throw new Error(`Complete ${step} delivery: ${completeError?.message ?? "no row"}`);
}

function requireDb(error: { message: string } | null, step: string): void {
  if (error) throw new Error(`${step}: ${error.message}`);
}

/**
 * A message we sent came back undeliverable (or the recipient marked it spam).
 *
 * Resend accepts a send to a mistyped address with a 200, so without this the
 * whole ladder — quote email, three chases, both deposit reminders — is recorded
 * as delivered while every one bounces, and at day 30 the chase cron marks the
 * lead declined/'no_response': a false loss reason for someone who never
 * received anything. Recording the bounce stops the silence three ways: the send
 * carries its real outcome, the lead's address is flagged, and chasing is paused
 * (which also keeps the lead out of the cron's lapse query, so the false loss
 * can no longer happen) with a call task naming what to do about it.
 *
 * A SOFT bounce (full mailbox, temporary defer) is recorded but does NOT
 * invalidate the address — those recover on their own and suppressing them would
 * lose real customers.
 */
async function processBounce(
  sb: Sb,
  eventType: string,
  data: NonNullable<InboundEvent["data"]>,
): Promise<{ matched: boolean }> {
  const providerId = data.email_id ?? data.id ?? null;
  const kind = classifyBounce(eventType, data.bounce?.type);
  const detail = data.bounce?.message ?? data.bounce?.subType ?? eventType;

  if (!providerId) {
    log.warn("webhook.resend.bounce_no_provider_id", { eventType });
    return { matched: false };
  }

  const { data: comm, error: commError } = await sb
    .from("communications")
    .select("id, lead_id, client_id, to_address, subject")
    .eq("provider_id", providerId)
    .limit(1)
    .maybeSingle();
  if (commError) {
    log.error("webhook.resend.bounce_lookup_failed", { providerId, error: commError.message });
    throw new Error(`bounce lookup failed: ${commError.message}`);
  }
  if (!comm) {
    // Nothing to attach it to (an alert or digest, or a row predating this).
    log.info("webhook.resend.bounce_unmatched", { providerId, eventType });
    return { matched: false };
  }

  const nowIso = new Date().toISOString();
  const { error: stampError } = await sb
    .from("communications")
    .update({ bounced_at: nowIso, bounce_kind: kind } as never)
    .eq("id", comm.id);
  if (stampError) log.warn("webhook.resend.bounce_stamp_failed", { commId: comm.id, error: stampError.message });

  // Transient failures clear themselves — record and stop there.
  if (!suppressesAddress(kind)) {
    log.info("webhook.resend.soft_bounce", { commId: comm.id, to: comm.to_address });
    return { matched: true };
  }

  if (!comm.lead_id) return { matched: true };

  const reason = kind === "complaint"
    ? "The recipient marked our email as spam."
    : `Email to ${comm.to_address} hard-bounced (${detail}).`;
  const { error: leadError } = await sb
    .from("leads")
    .update({ email_invalid_at: nowIso, email_invalid_reason: reason.slice(0, 300), chase_paused: true } as never)
    .eq("id", comm.lead_id);
  if (leadError) log.warn("webhook.resend.bounce_lead_flag_failed", { leadId: comm.lead_id, error: leadError.message });

  // One open call task per lead — the office cannot email their way out of this.
  const { data: openTask } = await sb
    .from("follow_ups")
    .select("id")
    .eq("lead_id", comm.lead_id)
    .eq("reason", "custom")
    .eq("source", "email_bounced")
    .eq("status", "open")
    .limit(1)
    .maybeSingle();
  const notes = kind === "complaint"
    ? `${comm.to_address} marked our email as spam — stop emailing them and call instead if the job is still live.`
    : `Email to ${comm.to_address} bounced, so automatic reminders can't reach them — call to confirm the right address. (${detail})`;
  if (!openTask) {
    const { data: lead } = await sb.from("leads").select("estimator_id").eq("id", comm.lead_id).maybeSingle();
    await sb.from("follow_ups").insert({
      lead_id: comm.lead_id,
      client_id: comm.client_id,
      reason: "custom",
      status: "open",
      due_at: nowIso,
      assigned_to: lead?.estimator_id ?? null,
      source: "email_bounced",
      notes,
    } as never);
  } else {
    await sb.from("follow_ups").update({ notes, due_at: nowIso }).eq("id", openTask.id);
  }

  await sb.from("activities").insert({
    lead_id: comm.lead_id,
    client_id: comm.client_id,
    actor_id: null,
    type: "note",
    summary: kind === "complaint"
      ? `Recipient marked our email as spam (${comm.subject ?? "email"}) — chasing paused`
      : `Email to ${comm.to_address} bounced — chasing paused, call task raised`,
    meta: { communication_id: comm.id, bounce_kind: kind, auto: true },
  });

  await sendOpsAlert(`Email undeliverable — ${comm.to_address}`, [
    `<strong>${esc(comm.to_address)}</strong> ${kind === "complaint" ? "marked our email as spam" : "bounced"}: ${esc(detail)}.`,
    `Chasing is paused for that lead and a call task is in Follow-ups. Their automatic reminders will not reach them until the address is corrected.`,
  ], "system").catch(() => {});

  return { matched: true };
}

async function processInbound(
  sb: Sb,
  eventId: string,
  leaseToken: string,
  event: InboundEvent,
): Promise<{ matched: boolean }> {
  const data = event.data!;
  if (event.type && BOUNCE_EVENTS.has(event.type)) {
    return processBounce(sb, event.type, data);
  }
  const token = (data.to ?? []).map(tokenFromReplyAddress).find(Boolean) ?? null;
  const from = data.from ?? "unknown sender";
  const subject = data.subject ?? "(no subject)";
  const emailId = data.email_id ?? data.id;
  const quote = token ? await fetchQuoteByToken(sb, token) : null;

  if (!quote) {
    if (shouldForwardUnmatched(from)) {
      const content = emailId ? await fetchReceivedEmail(emailId) : null;
      const rawUnmatched = replyBodySource(content);
      const parts = splitReply(rawUnmatched);
      const unmatchedText = parts.reply || rawUnmatched.trim() || "(no message body retrieved)";
      await sendDurableWebhookEmail(sb, eventId, leaseToken, "unmatched_forward", {
        to: process.env.INBOUND_FORWARD_EMAIL || "hello@marleymoves.co.uk",
        subject: `Unmatched inbound email — ${subject}`,
        html: forwardBodyHtml(
          `An email arrived at the reply address but couldn't be matched to a job. Reply directly to <strong>${esc(from)}</strong> if it's a real customer.`,
          unmatchedText,
          parts.reply ? parts.quoted : "",
          `From ${esc(from)} · subject: ${esc(subject)}`,
        ),
        replyTo: from,
        idempotencyKey: `marley-inbound-unmatched/${eventId}`,
      });
    }
    return { matched: false };
  }

  const content = emailId ? await fetchReceivedEmail(emailId) : null;
  // Forward (and log) only the customer's NEW words — strip the quoted quote email
  // their client appends, which otherwise arrives as an unreadable "| | |" wall.
  // An HTML-only reply (empty text part) is flattened from the HTML first, else
  // the message is lost to a placeholder (MMR020). Fall back to the raw body if
  // trimming would leave nothing (unusual bottom-post). The quoted half is kept
  // separately so the forward can show it as muted context — but only when the
  // reply itself extracted; on the raw fallback it would duplicate the body.
  const rawReply = replyBodySource(content);
  const replyParts = splitReply(rawReply);
  const bodyText = replyParts.reply || rawReply.trim() || "(open the forwarded copy for the message)";
  const quotedContext = replyParts.reply ? replyParts.quoted : "";

  if (quote.lead_id) {
    const { error } = await sb.from("leads").update({ chase_paused: true }).eq("id", quote.lead_id);
    requireDb(error, "pause chase");
  }

  const { error: commError } = await sb.from("communications").insert({
    client_id: quote.client_id,
    lead_id: quote.lead_id,
    quote_id: quote.id,
    channel: "email",
    direction: "inbound",
    to_address: from,
    to_norm: from.toLowerCase(),
    subject,
    body: bodyText.slice(0, 5000),
    content_hash: `inbound-${emailId ?? eventId}`,
    status: "sent",
    provider: "resend",
    provider_id: emailId ?? null,
    send_count: 1,
    first_sent_at: new Date().toISOString(),
    last_sent_at: new Date().toISOString(),
  });
  if (commError?.code !== "23505") requireDb(commError, "log inbound communication");

  if (quote.lead_id) {
    // One live "respond" task per lead. A customer who replies several times
    // before anyone actions it should REFRESH the same follow-up, not stack a
    // fresh identical card for every reply (2026-08-02: a lead showed twice on
    // /follow-ups — two inbound replies, two open tasks). The per-event unique
    // index (follow_ups_inbound_event_uq) already guards replay of ONE event;
    // this collapses DISTINCT replies, matching the "one open chase max" pattern
    // used throughout follow-ups/actions.ts.
    const followUpFields = {
      quote_id: quote.id,
      due_at: new Date().toISOString(),
      notes: `Customer replied to a chase email — respond. Subject: ${subject}`,
      metadata: { inbound_event_id: eventId },
    };
    const { data: openReply } = await sb
      .from("follow_ups")
      .select("id")
      .eq("lead_id", quote.lead_id)
      .eq("source", "inbound_reply")
      .eq("status", "open")
      .limit(1)
      .maybeSingle();
    if (openReply) {
      const { error: refreshError } = await sb.from("follow_ups").update(followUpFields).eq("id", openReply.id);
      requireDb(refreshError, "refresh inbound follow-up");
    } else {
      const { error: followUpError } = await sb.from("follow_ups").insert({
        lead_id: quote.lead_id,
        client_id: quote.client_id,
        reason: "custom",
        assigned_to: quote.estimator_id,
        source: "inbound_reply",
        ...followUpFields,
      });
      if (followUpError?.code !== "23505") requireDb(followUpError, "create inbound follow-up");
    }

    const { error: activityError } = await sb.from("activities").insert({
      lead_id: quote.lead_id,
      client_id: quote.client_id,
      actor_id: null,
      type: "note",
      summary: `Customer replied by email (${subject}) — chasing paused`,
      meta: { quote_id: quote.id, inbound_email_id: emailId ?? null, inbound_event_id: eventId },
    });
    if (activityError?.code !== "23505") requireDb(activityError, "create inbound activity");
  }

  const owner = await leadOwnerIdentity(sb, quote.lead_id, quote.estimator_id);
  const ownerMailbox = owner.email?.toLowerCase().endsWith("@marleymoves.co.uk") ? owner.email : null;
  const forwardTo = ownerMailbox || process.env.INBOUND_FORWARD_EMAIL || "hello@marleymoves.co.uk";
  const robotSender = !shouldForwardUnmatched(from);
  if (!robotSender) {
    const leadLink = quote.lead_id
      ? ` · <a href="https://ops.marleymoves.co.uk/leads/${quote.lead_id}" style="color:#c03838;">Open the lead in Marley Ops</a>`
      : "";
    await sendDurableWebhookEmail(sb, eventId, leaseToken, "owner_forward", {
      to: forwardTo,
      subject: `Reply from ${quote.customer_name ?? from} — ${quote.quote_ref}: ${subject}`,
      html: forwardBodyHtml(
        `<strong>${esc(quote.customer_name ?? "Customer")}</strong> (${esc(from)}) replied about quote <strong>${esc(quote.quote_ref)}</strong>. Chasing is paused.`,
        bodyText,
        quotedContext,
        `Reply directly to the customer at ${esc(from)}${leadLink}`,
      ),
      replyTo: from,
      idempotencyKey: `marley-inbound-forward/${eventId}`,
    });
  }

  await sendOpsAlert(
    `Customer replied — ${quote.quote_ref}`,
    [robotSender
      ? `An automated message hit the reply address for ${esc(quote.quote_ref)}. Chasing paused; check the lead's Comms tab.`
      : `${esc(quote.customer_name ?? "Customer")} replied to a chase email. Chasing paused; forwarded to the owner; follow-up opened.`],
    "business",
    `marley-inbound-alert/${eventId}`,
  );
  return { matched: true };
}

export async function POST(req: Request) {
  const secret = process.env.RESEND_INBOUND_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: "Webhook not configured" }, { status: 503 });

  const payload = await req.text();
  if (!verifySvix(payload, req.headers, secret)) {
    log.warn("webhook.resend.signature_invalid");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let event: InboundEvent;
  try {
    event = JSON.parse(payload) as InboundEvent;
  } catch {
    log.warn("webhook.resend.payload_invalid");
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }
  const eventType = event.type;
  const isBounce = !!eventType && BOUNCE_EVENTS.has(eventType);
  if (!eventType || (eventType !== "email.received" && !isBounce) || !event.data) {
    return NextResponse.json({ ok: true });
  }

  const eventId = req.headers.get("svix-id")!;
  const payloadHash = createHash("sha256").update(payload).digest("hex");
  const sb = createAdminClient();
  const { data: claimRows, error: claimError } = await sb.rpc("claim_webhook_event", {
    p_provider: "resend",
    p_event_id: eventId,
    p_event_type: eventType,
    p_payload_hash: payloadHash,
    p_lease_seconds: 300,
  });
  const claim = claimRows?.[0];
  if (claimError || !claim) {
    await reportOperationalIssue(sb, {
      key: `webhook:resend:${eventId}`,
      severity: "error",
      source: "resend-inbound",
      event: "webhook.resend.claim_failed",
      message: "A verified Resend webhook could not be durably claimed.",
      context: { eventId, error: claimError?.message },
    });
    return NextResponse.json({ error: "Could not claim webhook" }, { status: 503 });
  }
  if (claim.decision === "completed") {
    await resolveOperationalIssue(sb, `webhook:resend:${eventId}`);
    log.info("webhook.resend.replay_completed", { eventId, attemptCount: claim.attempt_count });
    return NextResponse.json({ ok: true, replay: true });
  }
  if (claim.decision === "busy") {
    log.info("webhook.resend.replay_busy", { eventId, attemptCount: claim.attempt_count });
    return NextResponse.json({ error: "Webhook already processing" }, { status: 503, headers: { "Retry-After": "30" } });
  }
  if (claim.decision === "payload_mismatch") {
    await reportOperationalIssue(sb, {
      key: `webhook:resend:${eventId}`,
      severity: "critical",
      source: "resend-inbound",
      event: "webhook.resend.payload_mismatch",
      message: "A reused verified webhook ID arrived with a different payload.",
      context: { eventId, attemptCount: claim.attempt_count },
    });
    return NextResponse.json({ error: "Webhook payload mismatch" }, { status: 409 });
  }
  if (claim.decision !== "claimed" || !claim.lease_token) {
    return NextResponse.json({ error: "Unexpected webhook claim state" }, { status: 503 });
  }

  log.info("webhook.resend.claimed", { eventId, attemptCount: claim.attempt_count });
  try {
    const outcome = await processInbound(sb, eventId, claim.lease_token, event);
    const { data: completed, error: completeError } = await sb.rpc("complete_webhook_event", {
      p_provider: "resend",
      p_event_id: eventId,
      p_lease_token: claim.lease_token,
      p_outcome: outcome,
    });
    if (completeError || !completed) throw new Error(completeError?.message ?? "Webhook lease was lost before completion");
    await resolveOperationalIssue(sb, `webhook:resend:${eventId}`);
    log.info("webhook.resend.completed", { eventId, matched: outcome.matched });
    return NextResponse.json({ ok: true, ...outcome });
  } catch (error) {
    const context = errorContext(error);
    const { data: failed, error: failError } = await sb.rpc("fail_webhook_event", {
      p_provider: "resend",
      p_event_id: eventId,
      p_lease_token: claim.lease_token,
      p_error: context.error,
    });
    if (failed) {
      await reportOperationalIssue(sb, {
        key: `webhook:resend:${eventId}`,
        severity: "error",
        source: "resend-inbound",
        event: "webhook.resend.failed",
        message: "A claimed inbound webhook failed before completion.",
        context: { eventId, error: context.error },
      });
    } else {
      log.warn("webhook.resend.stale_failure", { eventId, error: failError?.message ?? context.error });
    }
    return NextResponse.json({ error: "Inbound webhook failed" }, { status: 500 });
  }
}
