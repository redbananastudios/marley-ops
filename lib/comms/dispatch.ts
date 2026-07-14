/**
 * Session-free comms dispatcher — the single path every outbound customer email/
 * SMS takes: content-hash duplicate guard, provider send, communications log,
 * quote counters, activity entry. The dashboard server action wraps this with
 * the signed-in user's client; system flows (online accept, deposit cron) call
 * it with the admin client and a null actor.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { contentHash, normRecipient } from "@/lib/comms/hash";
import { sendEmail, sendSms } from "@/lib/comms/send";
import { brandedEmailHtml } from "@/lib/comms/branded-shell";
import { log } from "@/lib/log";

type Sb = SupabaseClient<Database>;

export interface DispatchCommInput {
  channel: "email" | "sms";
  to: string;
  bodyText: string; // plain text — used for SMS, preview, and the duplicate hash
  subject?: string; // email only
  bodyHtml?: string; // email only; falls back to a wrap of bodyText
  /** email only — send via a published Resend template instead of bodyHtml.
   *  bodyText is still required: it drives the duplicate hash + the Comms-tab preview. */
  template?: { id: string; variables?: Record<string, string | number> };
  attachmentBase64?: string; // email only (e.g. the quote PDF)
  attachmentName?: string;
  /** Reply-To override (chase emails: the per-lead reply-routing address). */
  replyTo?: string;
  /** Sender display override (chase emails: Peter Farrell at Marley Moves). */
  from?: string;
  leadId?: string;
  quoteId?: string;
  clientId?: string;
  override?: boolean; // send despite a duplicate match
  overrideReason?: string;
}

export type DispatchCommResult =
  | { ok: true }
  | { ok: false; error: string }
  | { duplicate: true; lastSentAt: string | null; sendCount: number };

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

  // Duplicate guard: identical content already sent (and not itself an override)?
  const { data: existing } = await sb
    .from("communications")
    .select("id, last_sent_at, send_count")
    .eq("content_hash", hash)
    .eq("status", "sent")
    .order("last_sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing && !input.override) {
    return { duplicate: true, lastSentAt: existing.last_sent_at, sendCount: existing.send_count };
  }

  // Send.
  const result =
    input.channel === "email"
      ? await sendEmail({
          to: input.to,
          subject: input.subject ?? "Message from Marley Moves",
          ...(input.template
            ? { template: input.template }
            : {
                // No explicit HTML → wrap the plain text in the branded house
                // shell (logo header + standard footer) so a manual panel send
                // never lands as a bare unstyled email.
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
        })
      : await sendSms({ to: input.to, body: input.bodyText });

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
  };

  if (!result.ok) {
    // Record the failure (status='failed' doesn't claim the hash, so a retry is allowed).
    const errMsg = result.error ?? "Send failed";
    await sb.from("communications").insert({ ...baseRow, status: "failed", provider_error: errMsg });
    return { ok: false, error: errMsg };
  }

  const now = new Date().toISOString();
  const { error: logErr } = await sb.from("communications").insert({
    ...baseRow,
    status: "sent",
    provider_id: result.providerId ?? null,
    send_count: 1,
    first_sent_at: now,
    last_sent_at: now,
  });
  if (logErr) {
    // The DB duplicate-guard (partial unique index on content_hash where sent)
    // rejected this row — almost always a concurrent identical send that already
    // landed. The provider send has ALREADY happened and can't be unsent, so log
    // it: a genuine double-send is now visible instead of silently swallowed.
    log.warn("comm.sent_log_insert_failed", {
      channel: input.channel,
      quoteId: input.quoteId ?? null,
      leadId: input.leadId ?? null,
      error: logErr.message,
    });
  }

  // Stamp the quote's send counters + email fields.
  if (input.quoteId) {
    const { data: q } = await sb
      .from("quotes")
      .select("email_send_count, sms_send_count, email_sent_at")
      .eq("id", input.quoteId)
      .single();
    if (input.channel === "email") {
      await sb
        .from("quotes")
        .update({
          email_sent: true,
          // Set-once: email_sent_at anchors the 30-day accept expiry AND the
          // chase cadence / auto-lapse, so it must stay pinned to the ORIGINAL
          // quote email. Letting a chase reminder move it silently stretched the
          // 2/5/10-day cadence to 2/7/17 and re-extended the price-validity +
          // accept-link window on every send (bug found in the 2026-07-12 sweep).
          email_sent_at: q?.email_sent_at ?? now,
          email_message_id: result.providerId ?? null,
          email_send_count: (q?.email_send_count ?? 0) + 1,
        })
        .eq("id", input.quoteId);
    } else {
      await sb
        .from("quotes")
        .update({ sms_send_count: (q?.sms_send_count ?? 0) + 1 })
        .eq("id", input.quoteId);
    }
  }

  // Timeline entry.
  if (input.leadId || input.clientId) {
    await sb.from("activities").insert({
      lead_id: input.leadId ?? null,
      client_id: input.clientId ?? null,
      actor_id: actorId,
      type: input.channel === "email" ? "email_sent" : "sms_sent",
      summary: `${input.channel === "email" ? "Email" : "SMS"} sent to ${input.to}${
        input.subject ? ` — ${input.subject}` : ""
      }`,
      meta: { provider_id: result.providerId ?? null, override: !!input.override },
    });
  }

  return { ok: true };
}

/**
 * Internal ops alert (new acceptance, deposit landed, Zoho failure). Direct
 * Resend send — not customer comms, so it skips the duplicate guard and the
 * communications log. Fail-soft: alerting must never break the main flow.
 */
export async function sendOpsAlert(subject: string, lines: string[]): Promise<void> {
  const to = process.env.OPS_ALERT_EMAIL || "peter@redbananastudios.com";
  try {
    await sendEmail({
      to,
      subject: `[Marley Ops] ${subject}`,
      html: `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;color:#1a1a1a;line-height:1.7;">${lines
        .map((l) => `<p style="margin:0 0 6px;">${l}</p>`)
        .join("")}</div>`,
    });
  } catch {
    /* alert best-effort only */
  }
}
