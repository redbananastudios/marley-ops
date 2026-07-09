/**
 * Post-move review ask — SERVER ONLY. One email per lead, ever
 * (leads.review_requested_at is the claim), gated on the Google review URL in
 * Settings. Fired when a lead reaches COMPLETED: by the daily cron's
 * auto-complete pass, or by staff marking it completed by hand.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { getBusinessSettings } from "@/lib/settings";
import { dispatchComm } from "@/lib/comms/dispatch";
import { buildReviewRequestEmailHtml } from "@/lib/comms/payment-email";
import { replyAddressFor } from "@/lib/quote/chase";

type Sb = SupabaseClient<Database>;

export async function sendReviewRequest(
  sb: Sb,
  leadId: string,
  actorId: string | null,
): Promise<{ sent: boolean; reason?: string }> {
  const settings = await getBusinessSettings(sb);
  const reviewUrl = settings.googleReviewUrl?.trim();
  if (!reviewUrl) return { sent: false, reason: "no review URL in Settings" };

  const { data: lead } = await sb
    .from("leads")
    .select("id, client_id, name, email, review_requested_at")
    .eq("id", leadId)
    .maybeSingle();
  if (!lead?.email) return { sent: false, reason: "no email on the lead" };
  if (lead.review_requested_at) return { sent: false, reason: "already asked" };

  // Claim first — a cron/staff race must never double-send.
  const { data: won } = await sb
    .from("leads")
    .update({ review_requested_at: new Date().toISOString() } as never)
    .eq("id", leadId)
    .is("review_requested_at", null)
    .select("id");
  if (!won?.length) return { sent: false, reason: "already asked" };

  // Route any reply back into the panel via the lead's latest quote token.
  const { data: q } = await sb
    .from("quotes")
    .select("accept_token")
    .eq("lead_id", leadId)
    .not("accept_token", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const token = (q?.accept_token as string | null) ?? null;

  const first = (lead.name ?? "").trim().split(/\s+/)[0] || "there";
  const res = await dispatchComm(sb, actorId, {
    channel: "email",
    to: lead.email,
    subject: `How did we do, ${first}?`,
    bodyText: `Thanks for moving with Marley Moves. If we looked after you, a quick Google review makes a real difference to us: ${reviewUrl} — and if anything wasn't right, reply to this email or call Connor on 01747 637070 first.`,
    bodyHtml: buildReviewRequestEmailHtml({ firstName: lead.name, reviewUrl }),
    replyTo: token ? replyAddressFor(token) : undefined,
    from: "Connor at Marley Moves <quotes@marleymoves.co.uk>",
    leadId,
    clientId: lead.client_id ?? undefined,
  });

  if (!("ok" in res && res.ok)) {
    // Send failed → release the claim so the next completion pass retries.
    if ("ok" in res && !res.ok) {
      await sb.from("leads").update({ review_requested_at: null } as never).eq("id", leadId);
      return { sent: false, reason: res.error };
    }
    return { sent: false, reason: "duplicate" };
  }
  return { sent: true };
}
