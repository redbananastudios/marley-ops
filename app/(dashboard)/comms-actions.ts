"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { contentHash, normRecipient } from "@/lib/comms/hash";
import { sendEmail, sendSms } from "@/lib/comms/send";

export interface SendCommInput {
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
  leadId?: string;
  quoteId?: string;
  clientId?: string;
  override?: boolean; // send despite a duplicate match
  overrideReason?: string;
}

export type SendCommResult =
  | { ok: true }
  | { ok: false; error: string }
  | { duplicate: true; lastSentAt: string | null; sendCount: number };

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function sendCommunication(input: SendCommInput): Promise<SendCommResult> {
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();

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
            : { html: input.bodyHtml ?? `<p>${escapeHtml(input.bodyText).replace(/\n/g, "<br>")}</p>` }),
          attachments: input.attachmentBase64
            ? [{ filename: input.attachmentName ?? "attachment.pdf", content: input.attachmentBase64 }]
            : undefined,
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
    sent_by: user?.id ?? null,
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
  await sb.from("communications").insert({
    ...baseRow,
    status: "sent",
    provider_id: result.providerId ?? null,
    send_count: 1,
    first_sent_at: now,
    last_sent_at: now,
  });

  // Stamp the quote's send counters + email fields.
  if (input.quoteId) {
    const { data: q } = await sb
      .from("quotes")
      .select("email_send_count, sms_send_count")
      .eq("id", input.quoteId)
      .single();
    if (input.channel === "email") {
      await sb
        .from("quotes")
        .update({
          email_sent: true,
          email_sent_at: now,
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
      actor_id: user?.id ?? null,
      type: input.channel === "email" ? "email_sent" : "sms_sent",
      summary: `${input.channel === "email" ? "Email" : "SMS"} sent to ${input.to}${
        input.subject ? ` — ${input.subject}` : ""
      }`,
      meta: { provider_id: result.providerId ?? null, override: !!input.override },
    });
  }

  if (input.leadId) revalidatePath(`/leads/${input.leadId}`);
  if (input.quoteId) revalidatePath(`/quotes/${input.quoteId}`);
  return { ok: true };
}
