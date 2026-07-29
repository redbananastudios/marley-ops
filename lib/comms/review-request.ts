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
import { leadOwnerIdentity, ownerFrom } from "@/lib/comms/sender";

type Sb = SupabaseClient<Database>;

/** Where we send customers to review, by platform. Google is the default (drives
 *  local search); a lead that came via Checkatrade is asked on Checkatrade. */
export const REVIEW_LINKS = {
  google: { platform: "Google", url: "https://g.page/r/CXD_Yh4RUF1cEBM/review" },
  checkatrade: { platform: "Checkatrade", url: "https://www.checkatrade.com/give-feedback/trades/marleymoves" },
  trustpilot: { platform: "Trustpilot", url: "https://uk.trustpilot.com/evaluate/marleymoves.co.uk" },
} as const;

export async function sendReviewRequest(
  sb: Sb,
  leadId: string,
  actorId: string | null,
): Promise<{ sent: boolean; reason?: string }> {
  const settings = await getBusinessSettings(sb);
  const googleUrl = settings.googleReviewUrl?.trim() || REVIEW_LINKS.google.url;

  const { data: lead } = await sb
    .from("leads")
    .select("id, client_id, estimator_id, name, email, entry_channel, review_requested_at, review_suppressed")
    .eq("id", leadId)
    .maybeSingle();
  if (!lead?.email) return { sent: false, reason: "no email on the lead" };
  if (lead.review_requested_at) return { sent: false, reason: "already asked" };
  // Office/crew switched the review ask off for this job (customer wasn't fully
  // satisfied) — bail BEFORE the claim so a re-enable can still send later.
  if (lead.review_suppressed) return { sent: false, reason: "review request switched off for this job" };

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

  // Ask on the platform the lead came from — a Checkatrade lead is asked on
  // Checkatrade (feeds that profile); everyone else on Google (local-search default).
  const review =
    lead.entry_channel === "checkatrade"
      ? REVIEW_LINKS.checkatrade
      : { platform: "Google", url: googleUrl };

  const owner = await leadOwnerIdentity(sb, leadId, lead.estimator_id);
  const reviewFrom = ownerFrom(owner.name, owner.email);

  // Prefer the published Resend template (copy editable in the dashboard, no
  // deploy); the in-repo HTML is the fallback when the env id isn't set.
  const templateId = process.env.RESEND_TEMPLATE_REVIEW_REQUEST;
  const res = await dispatchComm(sb, actorId, {
    channel: "email",
    to: lead.email,
    subject: `How did we do, ${first}?`,
    bodyText: `Thanks for moving with Marley Moves. If Connor and the crew looked after you, a quick ${review.platform} review makes a real difference to us: ${review.url}. If anything wasn't right, reply to this email or call the team on 01747 637070 first.`,
    ...(templateId
      ? {
          template: {
            id: templateId,
            variables: { CUSTOMER_FIRST_NAME: first, REVIEW_PLATFORM: review.platform, REVIEW_URL: review.url },
          },
        }
      : { bodyHtml: buildReviewRequestEmailHtml({ firstName: lead.name, reviewUrl: review.url }) }),
    replyTo: token ? replyAddressFor(token) : undefined,
    // A personal ask converts better — the review request comes from the lead's
    // owner via the canonical rule (explicit owner, else the surveying
    // estimator; house identity when unowned).
    from: reviewFrom,
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
