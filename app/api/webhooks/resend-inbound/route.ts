import { createHmac, timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/comms/send";
import { sendOpsAlert } from "@/lib/comms/dispatch";
import { ownerIdentity, shouldForwardUnmatched } from "@/lib/comms/sender";
import { tokenFromReplyAddress } from "@/lib/quote/chase";
import { fetchQuoteByToken } from "@/lib/quote/accept-flow";

/**
 * Resend inbound webhook (`email.received`) — a customer replied to a chase
 * email. Their Reply-To was q-<acceptToken>@reply.marleymoves.co.uk, so the
 * recipient maps straight back to the quote/lead:
 *
 *   pause the chase → log the reply in the lead's Comms tab → open a
 *   "customer replied" follow-up → forward the message to the lead OWNER's
 *   own mailbox (Luke's replies go to Luke — owner-only per Peter 2026-07-16;
 *   the follow-up gives the rest of the office visibility) → ops alert.
 *
 * Mail to the reply domain that DOESN'T resolve to a quote is no longer
 * silently dropped — it forwards to the front door (hello@) so a mangled
 * token or a hand-typed address still reaches a human.
 *
 * Signature: Resend webhooks are svix-signed. Verified manually against
 * RESEND_INBOUND_WEBHOOK_SECRET (whsec_...) — no svix dependency.
 */

export const dynamic = "force-dynamic";

function verifySvix(payload: string, headers: Headers, secret: string): boolean {
  const id = headers.get("svix-id");
  const timestamp = headers.get("svix-timestamp");
  const signatures = headers.get("svix-signature");
  if (!id || !timestamp || !signatures) return false;
  // Reject stale timestamps (replay guard, 5 min).
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${payload}`).digest("base64");
  return signatures.split(" ").some((part) => {
    const sig = part.split(",")[1] ?? "";
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Full received-email content (webhooks carry metadata only). */
async function fetchReceivedEmail(emailId: string): Promise<{ text?: string; html?: string } | null> {
  const key = process.env.MARLEY_RESEND_API_KEY || process.env.RESEND_API_KEY;
  if (!key) return null;
  for (const path of [`/emails/receiving/${emailId}`, `/emails/${emailId}`]) {
    try {
      const res = await fetch(`https://api.resend.com${path}`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (res.ok) return (await res.json()) as { text?: string; html?: string };
    } catch {
      /* try next */
    }
  }
  return null;
}

export async function POST(req: Request) {
  const secret = process.env.RESEND_INBOUND_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: "Webhook not configured" }, { status: 503 });

  const payload = await req.text();
  if (!verifySvix(payload, req.headers, secret)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const event = JSON.parse(payload) as {
    type?: string;
    data?: { email_id?: string; id?: string; from?: string; to?: string[]; subject?: string };
  };
  if (event.type !== "email.received" || !event.data) return NextResponse.json({ ok: true });

  const to = event.data.to ?? [];
  const token = to.map(tokenFromReplyAddress).find(Boolean) ?? null;

  const from = event.data.from ?? "unknown sender";
  const subject = event.data.subject ?? "(no subject)";
  const emailId = event.data.email_id ?? event.data.id;

  const sb = createAdminClient();
  const quote = token ? await fetchQuoteByToken(sb, token) : null;

  // Unresolvable inbound (no token / dead token): forward to the front door
  // instead of vanishing — a real customer can arrive via a mangled address.
  // Loop-guarded: our own domains and machine senders are dropped.
  if (!quote) {
    if (shouldForwardUnmatched(from)) {
      const content = emailId ? await fetchReceivedEmail(emailId) : null;
      const bodyText = content?.text?.trim() || "(no message body retrieved)";
      await sendEmail({
        to: process.env.INBOUND_FORWARD_EMAIL || "hello@marleymoves.co.uk",
        subject: `Unmatched inbound email — ${subject}`,
        html: `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;color:#1a1a1a;line-height:1.7;">
          <p>An email arrived at the reply address but couldn't be matched to a job. Reply directly to <strong>${esc(from)}</strong> if it's a real customer.</p>
          <hr style="border:none;border-top:1px solid #e4e4e7;">
          <div style="white-space:pre-wrap;">${esc(bodyText)}</div>
        </div>`,
        replyTo: from,
      });
    }
    return NextResponse.json({ ok: true, matched: false });
  }

  const content = emailId ? await fetchReceivedEmail(emailId) : null;
  const bodyText = content?.text?.trim() || "(open the forwarded copy for the message)";

  // 1. Stop chasing — a human conversation has started.
  if (quote.lead_id) {
    await sb.from("leads").update({ chase_paused: true } as never).eq("id", quote.lead_id);
  }

  // 2. Log the inbound reply where staff look (the lead's Comms tab).
  await sb.from("communications").insert({
    client_id: quote.client_id,
    lead_id: quote.lead_id,
    quote_id: quote.id,
    channel: "email",
    direction: "inbound",
    to_address: from,
    to_norm: from.toLowerCase(),
    subject,
    body: bodyText.slice(0, 5000),
    content_hash: `inbound-${emailId ?? Date.now()}`,
    status: "sent",
    provider: "resend",
    provider_id: emailId ?? null,
    send_count: 1,
    first_sent_at: new Date().toISOString(),
    last_sent_at: new Date().toISOString(),
  });

  // 3. A human takes over — task due now.
  if (quote.lead_id) {
    const { data: open } = await sb
      .from("follow_ups").select("id")
      .eq("lead_id", quote.lead_id).eq("reason", "custom").eq("status", "open")
      .eq("source", "inbound_reply").limit(1).maybeSingle();
    if (!open) {
      await sb.from("follow_ups").insert({
        lead_id: quote.lead_id,
        client_id: quote.client_id,
        quote_id: quote.id,
        reason: "custom",
        due_at: new Date().toISOString(),
        assigned_to: quote.estimator_id,
        source: "inbound_reply",
        notes: `Customer replied to a chase email — respond. Subject: ${subject}`,
      } as never);
    }
    await sb.from("activities").insert({
      lead_id: quote.lead_id,
      client_id: quote.client_id,
      actor_id: null,
      type: "note",
      summary: `Customer replied by email (${subject}) — chasing paused`,
      meta: { quote_id: quote.id, inbound_email_id: emailId ?? null },
    });
  }

  // 4. Forward to the LEAD OWNER's own mailbox (owner-only — Peter's explicit
  //    pick 2026-07-16: Connor must not receive Luke's threads; the panel's
  //    follow-up queue is the shared-visibility net). Unowned lead, inactive
  //    owner or off-domain login → the front door.
  const owner = await ownerIdentity(sb, quote.estimator_id);
  const ownerMailbox =
    owner.email && owner.email.toLowerCase().endsWith("@marleymoves.co.uk") ? owner.email : null;
  const forwardTo = ownerMailbox || process.env.INBOUND_FORWARD_EMAIL || "hello@marleymoves.co.uk";
  await sendEmail({
    to: forwardTo,
    subject: `Reply from ${quote.customer_name ?? from} — ${quote.quote_ref}: ${subject}`,
    html: `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;color:#1a1a1a;line-height:1.7;">
      <p><strong>${quote.customer_name ?? "Customer"}</strong> (${from}) replied about quote <strong>${quote.quote_ref}</strong>. Chasing is paused.</p>
      <hr style="border:none;border-top:1px solid #e4e4e7;">
      <div style="white-space:pre-wrap;">${esc(bodyText)}</div>
      <hr style="border:none;border-top:1px solid #e4e4e7;">
      <p style="font-size:12px;color:#71717a;">Reply directly to the customer at ${esc(from)}. Lead: https://ops.marleymoves.co.uk/leads/${quote.lead_id ?? ""}</p>
    </div>`,
    replyTo: from,
  });

  await sendOpsAlert(`Customer replied — ${quote.quote_ref}`, [
    `${quote.customer_name ?? from} replied to a chase email (${subject}). Chasing paused; forwarded to ${forwardTo}; follow-up opened.`,
  ]);

  return NextResponse.json({ ok: true, matched: true });
}
