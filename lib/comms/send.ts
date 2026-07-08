/** Low-level senders. SERVER ONLY. A COMMS_DRYRUN=true env short-circuits to a simulated
 *  success so the panel's send + duplicate-guard flow is testable locally without real sends. */

export interface SendResult {
  ok: boolean;
  providerId?: string;
  error?: string;
}

const DRYRUN = process.env.COMMS_DRYRUN === "true";

export async function sendEmail(input: {
  to: string;
  subject: string;
  html: string;
  attachments?: { filename: string; content: string }[]; // content = base64
}): Promise<SendResult> {
  if (DRYRUN) return { ok: true, providerId: `dryrun-email-${Date.now()}` };
  const key = process.env.MARLEY_RESEND_API_KEY || process.env.RESEND_API_KEY;
  if (!key) return { ok: false, error: "Resend API key not configured" };
  const from = process.env.RESEND_FROM_EMAIL || "Marley Moves <quotes@marleymoves.co.uk>";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [input.to],
        reply_to: "hello@marleymoves.co.uk",
        subject: input.subject,
        html: input.html,
        attachments: input.attachments,
      }),
    });
    const json = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!res.ok) return { ok: false, error: json.message || `Resend error ${res.status}` };
    return { ok: true, providerId: json.id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Email send failed" };
  }
}

export async function sendSms(input: { to: string; body: string }): Promise<SendResult> {
  if (DRYRUN) return { ok: true, providerId: `dryrun-sms-${Date.now()}` };
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
      body: JSON.stringify({ from: sender, message_body: input.body, to: [{ phone: [to] }] }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      messages?: { transaction_id?: string }[];
      message?: string;
      error?: string;
    };
    if (!res.ok) return { ok: false, error: json.message || json.error || `WebEx error ${res.status}` };
    return { ok: true, providerId: json.messages?.[0]?.transaction_id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "SMS send failed" };
  }
}
