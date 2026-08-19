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
import { selectReviewLink } from "@/lib/comms/review-platform";

type Sb = SupabaseClient<Database>;

export async function sendReviewRequest(
  sb: Sb,
  leadId: string,
  actorId: string | null,
): Promise<{ sent: boolean; reason?: string }> {
  const settings = await getBusinessSettings(sb);
  // The Settings field is the review-ask kill switch — the Settings UI has
  // always said "clear it to switch the review ask off", so a cleared value
  // sends NOTHING rather than silently falling back to a hardcoded link.
  // Bails before the claim, so switching it back on can still send later.
  const googleUrl = settings.googleReviewUrl?.trim() ?? "";
  if (!googleUrl) return { sent: false, reason: "review ask switched off in Settings" };

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

  // Ask where this customer can actually leave the review: a Checkatrade lead
  // on Checkatrade (feeds the profile they found us on), a Google-mailbox
  // customer on Google (a Google review needs a Google account), everyone
  // else on Trustpilot (no account barrier). Routing is pure + unit-tested.
  const review = selectReviewLink(lead.email, lead.entry_channel, googleUrl);

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
    // bodyHtml rides alongside the template as the rendered fallback (oversize
    // guard + SMTP outage transport) — the template wins when usable.
    bodyHtml: buildReviewRequestEmailHtml({ firstName: lead.name, reviewUrl: review.url, platform: review.platform }),
    ...(templateId
      ? {
          template: {
            id: templateId,
            variables: { CUSTOMER_FIRST_NAME: first, REVIEW_PLATFORM: review.platform, REVIEW_URL: review.url },
          },
        }
      : {}),
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
